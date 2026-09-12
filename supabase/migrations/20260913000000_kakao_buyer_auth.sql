-- ====================================================================
-- 바이어 인증 전환: 서명 쿠키(wsale_customer_session) 폐기 → 카카오 OAuth 단일화
--
-- 변경 전(폐기):
--   알림톡 링크 진입 → HMAC 서명 쿠키에 retailer_id 를 담아 신원 판정
--   → 링크/쿠키가 유출되면 타인이 그대로 대리 조작 가능
--
-- 변경 후:
--   알림톡 링크 진입 → 최초 1회 카카오 로그인(Supabase Auth)
--   → auth.uid() ↔ profiles ↔ retailers 매핑으로 retailer_id 확정
--   → 이후 모든 RLS/서버 액션 판정은 auth.uid() 만 신뢰
--   → 링크가 유출돼도 공격자의 카카오 계정으로는 타인의 retailer_id 를 얻지 못한다
--
-- 이 마이그레이션은 전체가 멱등(idempotent)하므로 재실행해도 안전하다.
-- ====================================================================

-- ====================================================================
-- 1. 미니샵 진입 게이트용 공개 조회
--
--    신규 바이어는 아직 wholesaler_retailers 링크가 없어 wholesalers SELECT 정책
--    ("활성 거래처만 열람")을 통과할 수 없다. 로그인 게이트에 공급사 상호를 띄우려면
--    활성 공급사의 '상호/대표자'만 노출하는 최소 범위 함수가 필요하다.
--    (상품·단가·거래처 정보는 일절 포함하지 않는다)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.get_public_shop_identity(p_shop_token UUID)
RETURNS TABLE (
    wholesaler_id UUID,
    business_name TEXT,
    representative_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT w.id, w.business_name, w.representative_name
    FROM public.wholesalers w
    WHERE w.shop_token = p_shop_token
      AND w.status = 'active';
$$;

REVOKE ALL ON FUNCTION public.get_public_shop_identity(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_shop_identity(UUID) TO anon, authenticated;

-- ====================================================================
-- 2. 초대 링크 클레임: auth.uid() ↔ retailer_id 매핑 확정
--
--    "알림톡으로 받은 shop_token 을 알고 있다"는 사실이 초대의 증거다.
--    카카오 로그인 직후 이 함수를 호출해
--      profiles(role='retailer') → retailers → wholesaler_retailers(active)
--    까지 한 트랜잭션으로 만들어 retailer_id 권한을 확정한다.
--
--    SECURITY DEFINER 가 필요한 이유:
--      wholesaler_retailers 는 "공급사만 거래처를 등록" 정책이라 신규 바이어가
--      스스로 링크를 만들 수 없다. service_role 키를 앱에 두는 대신,
--      shop_token 검증을 내부에 박아 넣은 단일 목적 함수로 권한을 좁힌다.
--
--    신원 정보는 클라이언트 입력을 받지 않고 auth.users 메타데이터에서만 읽는다.
-- ====================================================================
--    반환형을 jsonb 로 둔 이유: RETURNS TABLE 의 출력 컬럼명(retailer_id 등)은
--    PL/pgSQL 안에서 변수로 취급되어 동명의 테이블 컬럼과 충돌한다.
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
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;

    -- 2-1. shop_token → 활성 공급사
    SELECT w.id, w.business_name
      INTO v_wholesaler_id, v_business_name
    FROM public.wholesalers w
    WHERE w.shop_token = p_shop_token
      AND w.status = 'active';

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_SHOP_TOKEN';
    END IF;

    -- 2-2. 공급사/관리자 계정은 바이어로 전환할 수 없다 (경쟁사 염탐 차단)
    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_uid;

    IF v_role IN ('wholesaler', 'super_admin') THEN
        RAISE EXCEPTION 'NOT_A_BUYER_ACCOUNT';
    END IF;

    -- 2-3. 프로필 자동 생성 (카카오 메타데이터만 사용)
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

        INSERT INTO public.profiles (id, role, name, phone)
        VALUES (v_uid, 'retailer', COALESCE(v_name, '카카오 회원'), COALESCE(v_phone, ''));
    ELSE
        SELECT p.name INTO v_name FROM public.profiles p WHERE p.id = v_uid;
    END IF;

    -- 2-4. 식당(retailer) 자동 생성.
    --      상호/배송지는 최초 발주서 작성 화면에서 채워지므로 자리표시자로 둔다.
    SELECT r.id INTO v_retailer_id FROM public.retailers r WHERE r.profile_id = v_uid;

    IF v_retailer_id IS NULL THEN
        INSERT INTO public.retailers (profile_id, restaurant_name, representative_name, delivery_address)
        VALUES (v_uid, COALESCE(v_name, '카카오 회원'), COALESCE(v_name, '카카오 회원'), '')
        RETURNING id INTO v_retailer_id;
    END IF;

    -- 2-5. 거래 관계 연결.
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
-- 3. RLS 정비 — 쿠키가 사라졌으므로 모든 판정 근거가 auth.uid() 하나로 좁혀진다.
--    기존 정책은 이미 auth.uid() 기반이라 정책식 자체는 유지하고,
--    자동 생성(2번)된 계정이 스스로 권한을 넓히지 못하도록 구멍만 막는다.
-- ====================================================================

-- 3-1. profiles: WITH CHECK 누락 보완.
--      UPDATE 정책에 WITH CHECK 를 생략하면 USING 이 재사용되는데 USING 은
--      '변경 전' 행만 검사하므로, 통과한 사용자가 id 를 타인 값으로 바꿀 수 있었다.
DROP POLICY IF EXISTS "Profiles updatable by self" ON public.profiles;

CREATE POLICY "Profiles updatable by self" ON public.profiles
    FOR UPDATE
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

-- 3-2. role 자기 승격 차단.
--      자동 생성된 retailer 프로필이 스스로 role 을 'wholesaler' 로 바꾸면
--      get_current_wholesaler_id() 경로를 열 수 있다. 슈퍼관리자만 변경 가능.
CREATE OR REPLACE FUNCTION public.enforce_profile_role_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.role <> OLD.role AND public.get_current_role() <> 'super_admin' THEN
        RAISE EXCEPTION '역할(role)은 스스로 변경할 수 없습니다.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_role_immutable ON public.profiles;

CREATE TRIGGER trg_profiles_role_immutable
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_role_immutable();

-- 3-3. retailers: WITH CHECK 누락 보완.
--      바이어는 발주서 작성 시 상호/배송지를 채워야 하므로 UPDATE 는 열어두되,
--      자기 행을 타인 프로필로 넘기는 것은 막는다.
DROP POLICY IF EXISTS "Retailers updatable by self" ON public.retailers;

CREATE POLICY "Retailers updatable by self" ON public.retailers
    FOR UPDATE
    USING (profile_id = auth.uid())
    WITH CHECK (profile_id = auth.uid());

-- 3-4. 바이어 플로우가 건드리는 테이블 권한 명시.
--      (권한이 없으면 정책과 무관하게 permission denied 가 된다)
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.retailers TO authenticated;
GRANT SELECT ON public.wholesaler_retailers TO authenticated;
GRANT SELECT ON public.wholesalers TO authenticated;
GRANT SELECT ON public.products TO authenticated;
GRANT SELECT ON public.custom_prices TO authenticated;

-- 3-5. 폐기된 쿠키 경로 전용 함수 제거.
--      get_public_shop_catalog() 는 비로그인 카탈로그 열람(옵션 B)을 위한 것이었고,
--      이제 미니샵은 로그인 후에만 카탈로그를 노출하므로 공개 노출면을 줄인다.
DROP FUNCTION IF EXISTS public.get_public_shop_catalog(UUID);
