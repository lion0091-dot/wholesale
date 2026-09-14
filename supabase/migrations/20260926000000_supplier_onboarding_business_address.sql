-- ====================================================================
-- 사업장 주소를 공급사 온보딩(가입) 단계에서 필수로 받는다.
--
-- 지금까지는 기존 레코드 백필 우선으로 판단해 /dashboard/invites(가입 후
-- 별도 화면)에만 입력 폼을 뒀다(20260925000000_wholesaler_business_address.sql).
-- 이번에 그 결정을 뒤집어 신규 가입 시점에도 필수로 받도록 한다 — 이제
-- 새로 가입하는 공급사는 wholesalers.business_address가 항상 채워진 채로
-- 시작하므로, 거래명세서 PDF 발행 가드(findMissingStatementFields)에
-- 걸릴 일이 없다. /dashboard/invites 폼은 기존(가입 당시엔 이 필드가 없던)
-- 레코드 백필용으로 계속 남겨둔다.
--
-- complete_supplier_signup()은 파라미터 목록이 바뀌므로(새 필수 인자 추가)
-- CREATE OR REPLACE로는 기존 5-arg 함수를 대체할 수 없다 — 먼저 DROP하고
-- 6-arg로 다시 만든다. 본문은 최신 버전(20260921000000_staff_signup_channel.sql,
-- signup_channel='staff' 거절 가드 포함)을 그대로 베이스로 삼는다.
-- ====================================================================

DROP FUNCTION IF EXISTS public.complete_supplier_signup(TEXT, TEXT, TEXT, TEXT, BOOLEAN);

CREATE FUNCTION public.complete_supplier_signup(
    p_business_name       TEXT,
    p_representative_name TEXT,
    p_phone               TEXT,
    p_business_address    TEXT,
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
    v_business_address TEXT := NULLIF(btrim(p_business_address), '');
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

    IF v_business_address IS NULL OR length(v_business_address) < 5 THEN
        RAISE EXCEPTION 'INVALID_BUSINESS_ADDRESS';
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
            profile_id, business_name, business_number, representative_name, business_address, status
        )
        VALUES (v_uid, v_business_name, v_business_number, v_rep_name, v_business_address, 'pending')
        RETURNING id, shop_token INTO v_wholesaler_id, v_shop_token;
    ELSE
        UPDATE public.wholesalers
           SET business_name = v_business_name,
               representative_name = v_rep_name,
               business_number = COALESCE(v_business_number, business_number),
               business_address = v_business_address,
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

REVOKE ALL ON FUNCTION public.complete_supplier_signup(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_supplier_signup(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
