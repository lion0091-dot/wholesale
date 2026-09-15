-- ====================================================================
-- 바이어(구매 회원) 이용약관/개인정보 수집·이용 동의 기록
--
-- 배경:
--   공급사는 /onboarding에서 동의 체크박스를 통과해야 complete_supplier_signup()이
--   호출되지만, 바이어는 /shop/<token> 게이트에 "카카오로 3초 시작하기" 버튼만
--   있고 동의 화면 자체가 없다. claim_shop_access()는 거래 관계만 확정할 뿐
--   profiles.terms_agreed_at/privacy_agreed_at을 전혀 건드리지 않아 바이어
--   계정은 이 값이 영원히 NULL로 남는다.
--
--   PII(실제 카카오 이름) 저장 자체는 20260922000000(handle_new_user 지연 저장)
--   덕분에 바이어 쪽도 이미 자리표시자로 시작하므로 별도 조치가 필요 없다.
--   이 마이그레이션은 "동의를 실제로 받고 기록했는가"만 다룬다.
--
-- 설계:
--   record_buyer_consent(p_marketing_agreed)는 현재 세션(auth.uid()) 소유
--   profiles 행에 동의 시각만 기록한다. role/is_supplier/is_verified는
--   건드리지 않으므로 enforce_profile_role_immutable() 트리거의 권한 우회
--   플래그(app.supplier_onboarding)가 필요 없다 — 그 트리거는 그 세 컬럼만
--   감시한다.
--
--   complete_supplier_signup()과 동일하게 COALESCE로 최초 동의 시각만 보존한다
--   (재호출해도 덮어쓰지 않음 — 멱등).
-- ====================================================================

CREATE OR REPLACE FUNCTION public.record_buyer_consent(p_marketing_agreed BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid  UUID := auth.uid();
    v_now  TIMESTAMPTZ := now();
    v_role TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;

    SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;

    IF v_role IS DISTINCT FROM 'retailer' THEN
        RAISE EXCEPTION 'NOT_A_BUYER_ACCOUNT';
    END IF;

    UPDATE public.profiles
       SET terms_agreed_at = COALESCE(terms_agreed_at, v_now),
           privacy_agreed_at = COALESCE(privacy_agreed_at, v_now),
           marketing_agreed_at = CASE
               WHEN p_marketing_agreed THEN COALESCE(marketing_agreed_at, v_now)
               ELSE marketing_agreed_at
           END,
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
