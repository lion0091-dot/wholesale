-- ====================================================================
-- 손님(바이어) 동의 시점에 실제 전화번호를 저장 + 전화번호 중복 재확인
--
-- 배경: 154에서 claim_shop_access()에 전화번호 중복 가입 차단을 추가했지만,
--   그 체크는 이미 profiles.phone에 저장된 값과만 비교한다. 그런데 바이어의
--   실제 카카오 전화번호는 20260922000000(PII 지연 저장 설계)에 따라 동의
--   전에는 어디에도 저장되지 않으므로, 서로 다른 두 신규 손님 계정이 거의
--   동시에 가입하면(둘 다 아직 동의 전) 서로의 전화번호를 못 보고 둘 다
--   통과해버린다.
--
-- 수정: complete_supplier_signup()이 공급사 동의 통과 직후 실제 정보를
--   저장하는 것과 대칭으로, record_buyer_consent()도 동의 통과 직후 카카오
--   전화번호를 profiles.phone에 채운다(처음 한 번만 — 이미 값이 있으면
--   덮어쓰지 않음). 저장 직전에 154와 동일한 중복 검사를 한 번 더 해서,
--   claim_shop_access 단계를 어떻게든 통과한 중복 전화번호도 동의 단계에서
--   최종적으로 막는다.
--
-- PII 지연 저장 원칙은 그대로 유지된다 — 전화번호는 여전히 "이 서비스의
-- 동의를 통과한 시점"에만 저장되고, 그 전에는 어디에도 쓰이지 않는다.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.record_buyer_consent(p_marketing_agreed BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid   UUID := auth.uid();
    v_now   TIMESTAMPTZ := now();
    v_role  TEXT;
    v_phone TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;

    SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;

    IF v_role IS DISTINCT FROM 'retailer' THEN
        RAISE EXCEPTION 'NOT_A_BUYER_ACCOUNT';
    END IF;

    -- 이미 저장된 전화번호가 있으면 재확인할 필요 없음(최초 1회만 채움)
    SELECT p.phone INTO v_phone FROM public.profiles p WHERE p.id = v_uid;

    IF v_phone IS NULL OR v_phone = '' THEN
        SELECT COALESCE(
                   NULLIF(u.raw_user_meta_data ->> 'phone_number', ''),
                   NULLIF(u.phone, ''),
                   ''
               )
          INTO v_phone
        FROM auth.users u
        WHERE u.id = v_uid;

        IF v_phone <> '' AND EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.phone = v_phone AND p.id <> v_uid
        ) THEN
            RAISE EXCEPTION 'PHONE_ALREADY_REGISTERED';
        END IF;
    ELSE
        v_phone := NULL; -- 이미 있음 → 아래 UPDATE에서 덮어쓰지 않도록
    END IF;

    UPDATE public.profiles
       SET terms_agreed_at = COALESCE(terms_agreed_at, v_now),
           privacy_agreed_at = COALESCE(privacy_agreed_at, v_now),
           marketing_agreed_at = CASE
               WHEN p_marketing_agreed THEN COALESCE(marketing_agreed_at, v_now)
               ELSE marketing_agreed_at
           END,
           phone = CASE WHEN v_phone IS NOT NULL AND v_phone <> '' THEN v_phone ELSE phone END,
           updated_at = v_now
     WHERE id = v_uid;

    RETURN jsonb_build_object(
        'terms_agreed_at', v_now,
        'privacy_agreed_at', v_now
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_buyer_consent(BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_buyer_consent(BOOLEAN) TO authenticated;
