-- ====================================================================
-- 공급사 온보딩 재설계: 이메일/비밀번호 가입 폐기 → 카카오 3초 간편 가입 단일화
--
-- 변경 전(폐기):
--   공급사 전용 이메일/비밀번호 로그인 화면 + 플랫폼 관리자가 계정을 선발급
--   → 가입 자체가 관리자 승인 대기에 묶여 있어 첫 진입까지 며칠이 걸렸다
--
-- 변경 후:
--   카카오 로그인(바이어와 동일 채널) → auth.users 생성 즉시 트리거가
--   public.profiles 기본 레코드(is_supplier = true, is_verified = false)를 생성
--   → 최소 정보(약관 동의 + 연락처 + 상호)만 받고 바로 백오피스 사용 시작
--   → 행정 승인(사업자 검증)이 끝나기 전까지는 '초대장 발부' 권한만 잠긴다
--
-- 권한 모델 요약:
--   is_supplier = true,  is_verified = false → Pending Supplier
--       상품 등록/단가/발주/마이페이지 등 기본 기능 전부 허용, 초대장 발부만 차단
--   is_supplier = true,  is_verified = true  → 정회원 공급사 (초대장 발부 허용)
--   is_supplier = false                      → 바이어(구매 회원) 또는 플랫폼 관리자
--
-- 이 마이그레이션은 전체가 멱등(idempotent)하므로 재실행해도 안전하다.
-- ====================================================================

-- ====================================================================
-- 1. profiles 상태 플래그
--
--    role 컬럼은 레거시 RBAC(RLS 정책·헬퍼 함수)이 그대로 쓰고 있으므로 유지하고,
--    행정 승인 여부만 별도 불리언으로 분리한다. role 은 "무엇을 하는 계정인가",
--    is_verified 는 "행정 절차가 끝났는가"를 뜻한다.
-- ====================================================================
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS is_supplier BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false,
    -- 필수 약관(이용약관/개인정보) 동의 시각. NULL 이면 최소 정보 입력 전 단계다.
    ADD COLUMN IF NOT EXISTS terms_agreed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS privacy_agreed_at TIMESTAMPTZ,
    -- 선택 동의 (마케팅/알림톡 수신)
    ADD COLUMN IF NOT EXISTS marketing_agreed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.profiles.is_supplier IS
    '공급사(도매) 계정 여부. 카카오 가입 직후 트리거가 true 로 생성한다.';
COMMENT ON COLUMN public.profiles.is_verified IS
    '회사 승인 및 사업자 검증 완료 여부. false 면 초대장 발부만 차단된다.';

-- 1-1. 기존 데이터 백필 — 이미 승인된 공급사가 갑자기 초대장을 못 쓰면 안 된다.
UPDATE public.profiles p
   SET is_supplier = true
 WHERE p.role = 'wholesaler'
   AND p.is_supplier = false;

UPDATE public.profiles p
   SET is_verified = true,
       verified_at = COALESCE(p.verified_at, now())
 WHERE p.role = 'wholesaler'
   AND p.is_verified = false
   AND EXISTS (
       SELECT 1 FROM public.wholesalers w
        WHERE w.profile_id = p.id
          AND w.status = 'active'
   );

-- 기존 계정에도 동의 시각을 채워 온보딩 1단계로 되돌아가지 않게 한다.
UPDATE public.profiles p
   SET terms_agreed_at = COALESCE(p.terms_agreed_at, p.created_at),
       privacy_agreed_at = COALESCE(p.privacy_agreed_at, p.created_at)
 WHERE p.terms_agreed_at IS NULL
   AND EXISTS (SELECT 1 FROM public.wholesalers w WHERE w.profile_id = p.id);

-- ====================================================================
-- 2. 사업자등록번호를 가입 필수에서 제외
--
--    "최소 정보만 받고 즉시 시작"이 성립하려면 사업자등록번호는 가입 시점이 아니라
--    승인 심사 단계에서 받아야 한다. UNIQUE 는 유지되므로 중복 등록은 계속 막히고,
--    NULL 은 여러 행이 허용된다(미제출 상태).
-- ====================================================================
ALTER TABLE public.wholesalers ALTER COLUMN business_number DROP NOT NULL;
ALTER TABLE public.organizations ALTER COLUMN business_number DROP NOT NULL;

-- ====================================================================
-- 3. 카카오 가입 직후 profiles 기본 레코드 자동 생성
--
--    auth.users INSERT 와 같은 트랜잭션에서 실행되므로, 로그인 콜백이 어떤 이유로
--    중단되더라도 프로필 없는 고아 계정이 남지 않는다.
--
--    기본값을 '공급사 대기(is_supplier=true, is_verified=false)'로 두는 이유:
--      이 서비스에서 스스로 가입 화면을 찾아오는 사용자는 공급사뿐이다.
--      바이어는 공급사가 보낸 초대 링크(/shop/<token>)로만 들어오고, 그 경로는
--      claim_shop_access() 가 같은 요청 안에서 바이어로 전환한다(6번 참조).
-- ====================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_name  TEXT;
    v_phone TEXT;
BEGIN
    -- 신원 정보는 카카오가 준 메타데이터만 사용한다 (클라이언트 입력 없음).
    v_name := COALESCE(
        NULLIF(NEW.raw_user_meta_data ->> 'name', ''),
        NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''),
        NULLIF(NEW.raw_user_meta_data ->> 'preferred_username', ''),
        NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
        '카카오 회원'
    );

    v_phone := COALESCE(
        NULLIF(NEW.raw_user_meta_data ->> 'phone_number', ''),
        NULLIF(NEW.phone, ''),
        ''
    );

    INSERT INTO public.profiles (id, role, name, phone, is_supplier, is_verified)
    VALUES (NEW.id, 'wholesaler', v_name, v_phone, true, false)
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ====================================================================
-- 4. 권한 플래그 자기 승격 차단
--
--    profiles 는 본인 UPDATE 가 열려 있다(이름/연락처 수정). 따라서 role 뿐 아니라
--    is_supplier / is_verified 도 클라이언트가 직접 바꿀 수 없어야 한다.
--    승격이 필요한 내부 함수는 app.supplier_onboarding 세션 플래그로 자신을 밝힌다.
--    is_local => true 는 '함수 종료'가 아니라 '트랜잭션 종료'까지 값을 유지하므로,
--    각 함수는 권한이 필요한 UPDATE 직후 반드시 'off' 로 되돌린다.
--    (그러지 않으면 같은 트랜잭션의 뒤따르는 문장이 검사를 통째로 우회한다)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_role_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_privileged BOOLEAN;
BEGIN
    v_privileged :=
        COALESCE(current_setting('app.supplier_onboarding', true), '') = 'on'
        OR public.get_current_role() = 'super_admin';

    IF v_privileged THEN
        RETURN NEW;
    END IF;

    IF NEW.role <> OLD.role THEN
        RAISE EXCEPTION '역할(role)은 스스로 변경할 수 없습니다.';
    END IF;

    IF NEW.is_supplier <> OLD.is_supplier OR NEW.is_verified <> OLD.is_verified THEN
        RAISE EXCEPTION '승인 상태는 스스로 변경할 수 없습니다.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_role_immutable ON public.profiles;

CREATE TRIGGER trg_profiles_role_immutable
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_role_immutable();

-- ====================================================================
-- 5. 최소 정보 제출 = 공급사 온보딩 완료
--
--    한 트랜잭션에서 profiles(동의/연락처) + wholesalers(미니샵 토큰) +
--    organizations/organization_staff(조직 스코프)를 모두 세운다.
--    세 테이블은 RLS 정책이 서로 다르고(특히 조직 부트스트랩) 중간 실패 시
--    반쪽 상태가 남으므로, 단일 목적 SECURITY DEFINER 함수로 묶는다.
--
--    사업자등록번호는 선택 입력이다. 미제출 상태로도 백오피스는 전부 쓸 수 있고,
--    제출 + 슈퍼관리자 승인이 끝나야 is_verified = true 가 된다.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.complete_supplier_signup(
    p_business_name       TEXT,
    p_representative_name TEXT,
    p_phone               TEXT,
    p_business_number     TEXT DEFAULT NULL,
    p_marketing_agreed    BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid             UUID := auth.uid();
    v_now             TIMESTAMPTZ := now();
    v_business_name   TEXT := NULLIF(btrim(p_business_name), '');
    v_rep_name        TEXT := NULLIF(btrim(p_representative_name), '');
    v_phone           TEXT := NULLIF(regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g'), '');
    v_business_number TEXT := NULLIF(regexp_replace(COALESCE(p_business_number, ''), '[^0-9]', '', 'g'), '');
    v_role            TEXT;
    v_wholesaler_id   UUID;
    v_shop_token      UUID;
    v_organization_id UUID;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;

    IF v_business_name IS NULL OR length(v_business_name) < 2 THEN
        RAISE EXCEPTION 'INVALID_BUSINESS_NAME';
    END IF;

    IF v_rep_name IS NULL THEN
        RAISE EXCEPTION 'INVALID_REPRESENTATIVE_NAME';
    END IF;

    IF v_phone IS NULL OR length(v_phone) < 9 THEN
        RAISE EXCEPTION 'INVALID_PHONE';
    END IF;

    IF v_business_number IS NOT NULL AND length(v_business_number) <> 10 THEN
        RAISE EXCEPTION 'INVALID_BUSINESS_NUMBER';
    END IF;

    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_uid;

    -- 바이어로 확정된 계정은 같은 카카오 계정으로 공급사가 될 수 없다.
    -- (한 계정이 양쪽을 겸하면 경쟁사 단가를 들여다볼 수 있다)
    IF v_role = 'retailer' THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER_ACCOUNT';
    END IF;

    PERFORM set_config('app.supplier_onboarding', 'on', true);

    -- 5-1. 프로필: 동의 시각 + 연락처 확정, 공급사 대기 상태로 고정
    INSERT INTO public.profiles (
        id, role, name, phone, is_supplier, is_verified,
        terms_agreed_at, privacy_agreed_at, marketing_agreed_at
    )
    VALUES (
        v_uid, 'wholesaler', v_rep_name, v_phone, true, false,
        v_now, v_now, CASE WHEN p_marketing_agreed THEN v_now ELSE NULL END
    )
    ON CONFLICT (id) DO UPDATE
       SET name = v_rep_name,
           phone = v_phone,
           role = CASE WHEN profiles.role = 'super_admin' THEN 'super_admin' ELSE 'wholesaler' END,
           is_supplier = true,
           terms_agreed_at = COALESCE(profiles.terms_agreed_at, v_now),
           privacy_agreed_at = COALESCE(profiles.privacy_agreed_at, v_now),
           marketing_agreed_at = CASE
               WHEN p_marketing_agreed THEN COALESCE(profiles.marketing_agreed_at, v_now)
               ELSE NULL
           END,
           updated_at = v_now;

    -- 권한 우회 창을 profiles 쓰기 한 문장으로 제한한다.
    PERFORM set_config('app.supplier_onboarding', 'off', true);

    -- 5-2. 공급사 업체 레코드 — 미니샵 shop_token 이 여기서 발급된다.
    SELECT w.id, w.shop_token
      INTO v_wholesaler_id, v_shop_token
      FROM public.wholesalers w
     WHERE w.profile_id = v_uid;

    IF v_wholesaler_id IS NULL THEN
        IF v_business_number IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.wholesalers w WHERE w.business_number = v_business_number)
        THEN
            RAISE EXCEPTION 'DUPLICATE_BUSINESS_NUMBER';
        END IF;

        INSERT INTO public.wholesalers (
            profile_id, business_name, business_number, representative_name, status
        )
        VALUES (v_uid, v_business_name, v_business_number, v_rep_name, 'pending')
        RETURNING id, shop_token INTO v_wholesaler_id, v_shop_token;
    ELSE
        UPDATE public.wholesalers
           SET business_name = v_business_name,
               representative_name = v_rep_name,
               business_number = COALESCE(v_business_number, business_number),
               updated_at = v_now
         WHERE id = v_wholesaler_id;
    END IF;

    -- 5-3. 조직 스코프. 조직 소속이 없으면 백오피스 가드(미들웨어)가 통과시키지 않으므로
    --      가입 완료 시점에 1인 조직(owner)까지 만들어 준다.
    SELECT s.organization_id INTO v_organization_id
      FROM public.organization_staff s
     WHERE s.user_id = v_uid;

    IF v_organization_id IS NULL THEN
        SELECT o.id INTO v_organization_id
          FROM public.organizations o
         WHERE o.wholesaler_id = v_wholesaler_id;

        IF v_organization_id IS NULL THEN
            INSERT INTO public.organizations (
                wholesaler_id, name, business_number, representative_name, subscription_tier
            )
            VALUES (v_wholesaler_id, v_business_name, v_business_number, v_rep_name, 'pro')
            RETURNING id INTO v_organization_id;
        END IF;

        INSERT INTO public.organization_staff (organization_id, user_id, role)
        VALUES (v_organization_id, v_uid, 'owner')
        ON CONFLICT (organization_id, user_id) DO NOTHING;
    END IF;

    RETURN jsonb_build_object(
        'wholesaler_id', v_wholesaler_id,
        'organization_id', v_organization_id,
        'shop_token', v_shop_token,
        'business_name', v_business_name,
        'is_verified', false,
        'business_number_submitted', v_business_number IS NOT NULL
    );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_supplier_signup(TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_supplier_signup(TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;

-- ====================================================================
-- 6. 바이어 전환 경로 보정
--
--    3번 트리거가 모든 신규 계정을 '공급사 대기'로 만들기 때문에, 초대 링크로
--    들어온 신규 바이어도 role = 'wholesaler' 로 시작한다. 초대 토큰 소지는
--    바이어 의사의 증거이므로, 아직 공급사로서 아무것도 하지 않은
--    '미개시(pristine)' 프로필이면 바이어로 전환한다.
--
--    전환 불가(= 진짜 공급사) 판정 기준:
--      · is_verified = true (이미 승인된 공급사)
--      · terms_agreed_at IS NOT NULL (공급사 최소 정보 제출 완료)
--      · wholesalers / organization_staff 레코드 보유
-- ====================================================================
CREATE OR REPLACE FUNCTION public.claim_shop_access(p_shop_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid           UUID := auth.uid();
    v_wholesaler_id UUID;
    v_business_name TEXT;
    v_role          TEXT;
    v_name          TEXT;
    v_phone         TEXT;
    v_retailer_id   UUID;
    v_link_status   TEXT;
    v_pristine      BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;

    -- 6-1. shop_token → 활성 공급사
    SELECT w.id, w.business_name
      INTO v_wholesaler_id, v_business_name
    FROM public.wholesalers w
    WHERE w.shop_token = p_shop_token
      AND w.status = 'active';

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_SHOP_TOKEN';
    END IF;

    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_uid;

    -- 6-2. 슈퍼관리자는 바이어로 전환하지 않는다.
    IF v_role = 'super_admin' THEN
        RAISE EXCEPTION 'NOT_A_BUYER_ACCOUNT';
    END IF;

    -- 6-3. 공급사 기본값으로 만들어진 프로필의 바이어 전환
    IF v_role = 'wholesaler' THEN
        SELECT p.is_verified = false
               AND p.terms_agreed_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM public.wholesalers w WHERE w.profile_id = v_uid)
               AND NOT EXISTS (SELECT 1 FROM public.organization_staff s WHERE s.user_id = v_uid)
          INTO v_pristine
          FROM public.profiles p
         WHERE p.id = v_uid;

        IF NOT COALESCE(v_pristine, false) THEN
            RAISE EXCEPTION 'NOT_A_BUYER_ACCOUNT';
        END IF;

        PERFORM set_config('app.supplier_onboarding', 'on', true);

        UPDATE public.profiles
           SET role = 'retailer',
               is_supplier = false,
               is_verified = false,
               updated_at = now()
         WHERE id = v_uid;

        PERFORM set_config('app.supplier_onboarding', 'off', true);

        v_role := 'retailer';
    END IF;

    -- 6-4. 프로필 자동 생성 (카카오 메타데이터만 사용)
    IF v_role IS NULL THEN
        SELECT
            COALESCE(
                NULLIF(u.raw_user_meta_data ->> 'name', ''),
                NULLIF(u.raw_user_meta_data ->> 'full_name', ''),
                NULLIF(u.raw_user_meta_data ->> 'preferred_username', ''),
                '카카오 회원'
            ),
            COALESCE(
                NULLIF(u.raw_user_meta_data ->> 'phone_number', ''),
                NULLIF(u.phone, ''),
                ''
            )
          INTO v_name, v_phone
        FROM auth.users u
        WHERE u.id = v_uid;

        INSERT INTO public.profiles (id, role, name, phone, is_supplier, is_verified)
        VALUES (v_uid, 'retailer', COALESCE(v_name, '카카오 회원'), COALESCE(v_phone, ''), false, false)
        ON CONFLICT (id) DO NOTHING;
    END IF;

    SELECT p.name INTO v_name FROM public.profiles p WHERE p.id = v_uid;

    -- 6-5. 식당(retailer) 자동 생성.
    --      상호/배송지는 최초 발주서 작성 화면에서 채워지므로 자리표시자로 둔다.
    SELECT r.id INTO v_retailer_id FROM public.retailers r WHERE r.profile_id = v_uid;

    IF v_retailer_id IS NULL THEN
        INSERT INTO public.retailers (profile_id, restaurant_name, representative_name, delivery_address)
        VALUES (v_uid, COALESCE(v_name, '카카오 회원'), COALESCE(v_name, '카카오 회원'), '')
        RETURNING id INTO v_retailer_id;
    END IF;

    -- 6-6. 거래 관계 연결.
    --      이미 'blocked' 로 차단된 거래처는 링크 재클릭으로 부활하지 않는다.
    INSERT INTO public.wholesaler_retailers (wholesaler_id, retailer_id, status)
    VALUES (v_wholesaler_id, v_retailer_id, 'active')
    ON CONFLICT (wholesaler_id, retailer_id) DO NOTHING;

    SELECT wr.status INTO v_link_status
    FROM public.wholesaler_retailers wr
    WHERE wr.wholesaler_id = v_wholesaler_id
      AND wr.retailer_id = v_retailer_id;

    RETURN jsonb_build_object(
        'retailer_id', v_retailer_id,
        'wholesaler_id', v_wholesaler_id,
        'business_name', v_business_name,
        'is_linked', v_link_status = 'active'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_shop_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_shop_access(UUID) TO authenticated;

-- ====================================================================
-- 7. 승인 심사용 사업자등록번호 제출 (미승인 공급사 본인)
--
--    승인 완료 후에는 업체 동일성이 흔들리면 안 되므로 재제출을 막는다.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.submit_supplier_business_number(p_business_number TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid             UUID := auth.uid();
    v_number          TEXT := NULLIF(regexp_replace(COALESCE(p_business_number, ''), '[^0-9]', '', 'g'), '');
    v_wholesaler_id   UUID;
    v_is_verified     BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;

    IF v_number IS NULL OR length(v_number) <> 10 THEN
        RAISE EXCEPTION 'INVALID_BUSINESS_NUMBER';
    END IF;

    SELECT w.id INTO v_wholesaler_id
      FROM public.wholesalers w
     WHERE w.profile_id = v_uid;

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'SUPPLIER_NOT_FOUND';
    END IF;

    SELECT p.is_verified INTO v_is_verified FROM public.profiles p WHERE p.id = v_uid;

    IF COALESCE(v_is_verified, false) THEN
        RAISE EXCEPTION 'ALREADY_VERIFIED';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.wholesalers w
         WHERE w.business_number = v_number
           AND w.id <> v_wholesaler_id
    ) THEN
        RAISE EXCEPTION 'DUPLICATE_BUSINESS_NUMBER';
    END IF;

    UPDATE public.wholesalers
       SET business_number = v_number,
           updated_at = now()
     WHERE id = v_wholesaler_id;

    UPDATE public.organizations
       SET business_number = v_number,
           updated_at = now()
     WHERE wholesaler_id = v_wholesaler_id;

    RETURN jsonb_build_object('wholesaler_id', v_wholesaler_id, 'business_number', v_number);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_supplier_business_number(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_supplier_business_number(TEXT) TO authenticated;

-- ====================================================================
-- 8. 행정 승인 반영 (슈퍼관리자 전용)
--
--    승인은 업체(wholesalers) 단위 행위지만 플래그는 계정(profiles)에 있으므로,
--    해당 업체의 대표와 조직 소속 직원 전원에게 한 번에 반영한다.
--    (직원이 대표 승인 후에도 초대장을 못 쓰는 상태가 되지 않게 한다)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.set_supplier_verification(
    p_wholesaler_id UUID,
    p_verified      BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor   UUID := auth.uid();
    v_updated INT;
BEGIN
    IF v_actor IS NULL OR public.get_current_role() <> 'super_admin' THEN
        RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
    END IF;

    PERFORM set_config('app.supplier_onboarding', 'on', true);

    WITH targets AS (
        SELECT w.profile_id AS user_id
          FROM public.wholesalers w
         WHERE w.id = p_wholesaler_id
        UNION
        SELECT s.user_id
          FROM public.organization_staff s
          JOIN public.organizations o ON o.id = s.organization_id
         WHERE o.wholesaler_id = p_wholesaler_id
    )
    UPDATE public.profiles p
       SET is_verified = p_verified,
           verified_at = CASE WHEN p_verified THEN now() ELSE NULL END,
           verified_by = CASE WHEN p_verified THEN v_actor ELSE NULL END,
           updated_at = now()
     WHERE p.id IN (SELECT user_id FROM targets)
       AND p.role <> 'super_admin';

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    PERFORM set_config('app.supplier_onboarding', 'off', true);

    RETURN jsonb_build_object('updated', v_updated, 'is_verified', p_verified);
END;
$$;

REVOKE ALL ON FUNCTION public.set_supplier_verification(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_supplier_verification(UUID, BOOLEAN) TO authenticated;

-- ====================================================================
-- 9. 테이블 권한 — 공급사 셀프 온보딩 경로에 필요한 최소 권한
--    (실제 행 단위 통제는 기존 RLS 정책이 수행한다)
-- ====================================================================
GRANT SELECT, INSERT, UPDATE ON public.wholesalers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_staff TO authenticated;
