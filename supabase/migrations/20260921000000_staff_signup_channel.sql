-- ====================================================================
-- 스태프 가입 채널 표시 — "승인대기(공급사)"와 "후보대기(관리자 승격)"가
-- 절대 섞이지 않게 하는 구조적 가드.
--
-- 배경:
--   /staff-login(intent=staff)은 온보딩(app/staff-login/pending 참고)으로
--   보내지 않아서 보통은 wholesalers row가 안 생기지만, 그건 "기본 경로가
--   그리로 안 간다"일 뿐 "못 가게 막았다"가 아니었다. 같은 세션으로 /onboarding에
--   직접 들어가 완료하면 그대로 wholesalers row가 생겨 /admin/suppliers 승인
--   대기 목록에 실제 입점 신청자와 구분 없이 섞인다.
--
-- 해결:
--   profiles.signup_channel = 'staff'를 /auth/callback이 1회 기록하고,
--   complete_supplier_signup()이 이 값을 보고 온보딩 자체를 거절한다.
--   이러면 스태프 계정은 wholesalers row를 원천적으로 못 만들므로
--   "승인대기"에 들어갈 방법이 없다 — 기본 경로 문제가 아니라 쓰기 자체가 막힌다.
--
--   반대 방향(진짜 입점 신청자가 후보대기 검색에 뜨는 것)은 이 마이그레이션의
--   책임이 아니다 — app/admin/admins/actions.ts의 후보 검색 쿼리(다음 단계)가
--   wholesalers row 보유 여부로 걸러낸다.
--
-- 이 값은 보안 경계가 아니라 분류용 힌트다 — 자기 자신이 이 값을 조작해도
-- 얻는 이득이 없다(승격은 여전히 사람이 수동으로 하는 별개 절차). 그래서
-- enforce_profile_role_immutable() 트리거(role/is_supplier/is_verified 자기수정
-- 차단)는 건드리지 않는다.
--
-- 이 마이그레이션도 SQL Editor에 수동 적용한다(CLI/파이프라인 없음).
-- ====================================================================

-- ====================================================================
-- 1. profiles.signup_channel 컬럼
-- ====================================================================
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS signup_channel TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'profiles_signup_channel_check'
    ) THEN
        ALTER TABLE public.profiles
            ADD CONSTRAINT profiles_signup_channel_check
            CHECK (signup_channel IS NULL OR signup_channel = 'staff');
    END IF;
END;
$$;

COMMENT ON COLUMN public.profiles.signup_channel IS
    '가입 경로 분류 힌트. ''staff''면 /staff-login(intent=staff)으로 들어온 계정 —
     complete_supplier_signup()이 이 값을 보고 온보딩을 거절한다. NULL이 기본값(공급사/바이어).';

-- ====================================================================
-- 2. complete_supplier_signup() — 스태프 계정 온보딩 거절 가드 추가
--
--    기존 로직(20260914000000_supplier_kakao_onboarding.sql)은 그대로 두고,
--    기존 '바이어 전환 계정 거절' 체크 바로 옆에 조건 하나만 얹는다.
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
    v_signup_channel  TEXT;
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

    SELECT p.role, p.signup_channel
      INTO v_role, v_signup_channel
      FROM public.profiles p
     WHERE p.id = v_uid;

    -- 바이어로 확정된 계정은 같은 카카오 계정으로 공급사가 될 수 없다.
    -- (한 계정이 양쪽을 겸하면 경쟁사 단가를 들여다볼 수 있다)
    IF v_role = 'retailer' THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER_ACCOUNT';
    END IF;

    -- 내부 스태프 경로(/staff-login)로 들어온 계정은 공급사 온보딩 대상이
    -- 아니다 — 이 체크가 없으면 wholesalers row가 생겨 승인 대기 목록에
    -- 실제 입점 신청자와 섞인다(20260921000000 참고).
    IF v_signup_channel = 'staff' THEN
        RAISE EXCEPTION 'STAFF_ACCOUNT_CANNOT_ONBOARD';
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
