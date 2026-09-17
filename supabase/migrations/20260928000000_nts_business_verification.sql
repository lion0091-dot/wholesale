-- 국세청(공공데이터포털) 사업자등록정보 진위확인 API 연동.
--
-- 지금까지 "사업자등록증 진위 여부"는 체크섬(lib/validation/business-number.ts)만
-- 확인하고 실제로는 관리자가 눈으로 사본을 대조했다. 이제 국세청 실데이터와
-- 대조하는 진위확인(validate) API를 붙이는데, 이 API는 사업자번호 + 대표자성명 +
-- 개업일자 3개가 모두 있어야 호출할 수 있다. 대표자성명은 이미 있지만 개업일자는
-- 지금까지 어디서도 받지 않았다.
ALTER TABLE public.wholesalers
    ADD COLUMN business_start_date DATE,
    ADD COLUMN nts_verification_status TEXT NOT NULL DEFAULT 'unchecked'
        CHECK (nts_verification_status IN ('unchecked', 'match', 'mismatch', 'not_found', 'error')),
    ADD COLUMN nts_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.wholesalers.business_start_date IS
    '개업일자. 국세청 진위확인 API(validate) 호출에 필수 — 공급사가 /dashboard/invites에서 사업자등록번호와 함께 제출한다.';
COMMENT ON COLUMN public.wholesalers.nts_verification_status IS
    '국세청 진위확인 API 결과. unchecked=미실행, match=일치, mismatch=불일치, not_found=등록되지 않은 번호, error=API 호출 실패. 입점 승인(status=active)은 match일 때만 허용한다.';
COMMENT ON COLUMN public.wholesalers.nts_verified_at IS
    '마지막 국세청 진위확인 실행 시각.';

-- submit_supplier_business_number: 개업일자를 함께 받도록 확장.
-- 번호나 개업일자가 바뀌면 이전 진위확인 결과는 더 이상 유효하지 않으므로 초기화한다.
CREATE OR REPLACE FUNCTION public.submit_supplier_business_number(
    p_business_number     TEXT,
    p_business_start_date DATE DEFAULT NULL
)
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

    IF p_business_start_date IS NULL OR p_business_start_date > CURRENT_DATE THEN
        RAISE EXCEPTION 'INVALID_BUSINESS_START_DATE';
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
           business_start_date = p_business_start_date,
           nts_verification_status = 'unchecked',
           nts_verified_at = NULL,
           updated_at = now()
     WHERE id = v_wholesaler_id;

    UPDATE public.organizations
       SET business_number = v_number,
           updated_at = now()
     WHERE wholesaler_id = v_wholesaler_id;

    RETURN jsonb_build_object(
        'wholesaler_id', v_wholesaler_id,
        'business_number', v_number,
        'business_start_date', p_business_start_date
    );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_supplier_business_number(TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_supplier_business_number(TEXT, DATE) TO authenticated;

-- 국세청 진위확인 결과 저장 (슈퍼관리자 전용). RLS를 우회해야 하므로
-- SECURITY DEFINER + requireSuperAdmin은 애플리케이션(app/admin/suppliers/actions.ts)에서
-- assertSuperAdmin()으로 먼저 확인한 뒤 이 함수를 호출한다.
CREATE OR REPLACE FUNCTION public.set_nts_verification_result(
    p_wholesaler_id UUID,
    p_status        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL OR public.get_current_role() <> 'super_admin' THEN
        RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
    END IF;

    IF p_status NOT IN ('match', 'mismatch', 'not_found', 'error') THEN
        RAISE EXCEPTION 'INVALID_NTS_STATUS';
    END IF;

    UPDATE public.wholesalers
       SET nts_verification_status = p_status,
           nts_verified_at = now(),
           updated_at = now()
     WHERE id = p_wholesaler_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'SUPPLIER_NOT_FOUND';
    END IF;

    RETURN jsonb_build_object('wholesaler_id', p_wholesaler_id, 'nts_verification_status', p_status);
END;
$$;

REVOKE ALL ON FUNCTION public.set_nts_verification_result(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_nts_verification_result(UUID, TEXT) TO authenticated;
