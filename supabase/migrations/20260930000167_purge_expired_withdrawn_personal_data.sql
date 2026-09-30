-- 167: 탈퇴 후 보관기간(5년)이 지난 개인정보 자동 파기 (2026-09-30, 사장님 결정: 5년 / 개인정보만 / 명세서 파일 제외)
--
-- 탈퇴 시점에는 거래 증빙 보관의무 때문에 거래 기록을 지우지 않고 익명화만 했다(고객 RPC는 상호·주소 등을 이미 지움,
-- 공급사는 업체 행을 유지). 보관기간이 끝난 뒤에는 남은 개인정보를 파기한다:
--   * 공급사(status='closed', 탈퇴 5년 경과): 대표자명·사업장 주소·사업자등록증 경로·알림톡/PG/팝빌 자격정보 파기
--     (상호·사업자번호는 사업체 정보라 유지 — 개인정보 파기 범위에서 제외)
--   * 탈퇴 고객(5년 경과): 상호·사업자번호·대표자명·주소 파기
--   * 그 공급사·탈퇴 고객(5년 경과)의 주문: 배송지·배송요청·네고 메모 파기 (주문번호·금액·품목·이력번호는 유지)
--   * 공급처 명세서 파일(supplier_statement_files)은 건드리지 않는다.
-- 보관기간은 retention_years() 한 곳에서만 정한다 — 세법·이력법 원문 확인 후 바뀌면 이 함수만 새 마이그레이션으로 고친다.
-- 반환값: 크론이 Storage에서 함께 지울 사업자등록증 파일 경로. service_role 전용, 멱등(두 번 돌려도 같은 결과).

CREATE OR REPLACE FUNCTION public.withdrawn_data_retention()
RETURNS INTERVAL LANGUAGE sql IMMUTABLE AS $$ SELECT interval '5 years' $$;

CREATE OR REPLACE FUNCTION public.purge_expired_withdrawn_personal_data()
RETURNS TABLE (license_path TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesalers UUID[];
    v_retailers   UUID[];
BEGIN
    -- 1) 파기 대상 공급사·고객 계정 (탈퇴 시각 기준)
    SELECT COALESCE(array_agg(w.id), '{}') INTO v_wholesalers
      FROM public.wholesalers w
      JOIN public.profiles p ON p.id = w.profile_id
     WHERE w.status = 'closed'
       AND p.withdrawn_at IS NOT NULL
       AND p.withdrawn_at < now() - public.withdrawn_data_retention();

    SELECT COALESCE(array_agg(r.id), '{}') INTO v_retailers
      FROM public.retailers r
      JOIN public.profiles p ON p.id = r.profile_id
     WHERE p.withdrawn_at IS NOT NULL
       AND p.withdrawn_at < now() - public.withdrawn_data_retention();

    -- 2) 주문의 개인정보성 필드
    UPDATE public.orders o
       SET delivery_address = '(파기됨)',
           delivery_notes = NULL,
           negotiation_note = NULL
     WHERE (o.wholesaler_id = ANY(v_wholesalers)
            OR o.retailer_id = ANY(v_retailers))
       AND (o.delivery_address <> '(파기됨)' OR o.delivery_notes IS NOT NULL OR o.negotiation_note IS NOT NULL);

    -- 2-2) 탈퇴 고객의 상호·사업자번호·대표자명·주소 (168부터 탈퇴 즉시에는 상호·사업자번호를 남긴다)
    UPDATE public.retailers r
       SET restaurant_name = '(파기됨)',
           representative_name = '(파기됨)',
           business_number = NULL,
           delivery_address = '',
           delivery_address_detail = NULL
     WHERE r.id = ANY(v_retailers)
       AND (r.restaurant_name <> '(파기됨)' OR r.business_number IS NOT NULL OR r.delivery_address <> '');

    -- 3) 공급사 개인정보·자격정보
    RETURN QUERY
        SELECT w.business_license_path FROM public.wholesalers w
         WHERE w.id = ANY(v_wholesalers) AND w.business_license_path IS NOT NULL;

    UPDATE public.wholesalers w
       SET representative_name = '(파기됨)',
           business_address = NULL,
           business_license_path = NULL,
           alimtalk_account = NULL,
           alimtalk_password_encrypted = NULL,
           alimtalk_sender_key = NULL,
           alimtalk_sender_phone = NULL,
           pg_client_key = NULL,
           pg_secret_key_encrypted = NULL,
           popbill_member_id = NULL
     WHERE w.id = ANY(v_wholesalers)
       AND (w.representative_name <> '(파기됨)' OR w.business_address IS NOT NULL OR w.business_license_path IS NOT NULL
            OR w.alimtalk_password_encrypted IS NOT NULL OR w.pg_secret_key_encrypted IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_withdrawn_personal_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_withdrawn_personal_data() TO service_role;
COMMENT ON FUNCTION public.purge_expired_withdrawn_personal_data() IS
    '탈퇴 후 withdrawn_data_retention()(5년) 경과한 공급사·고객의 개인정보 파기. 명세서 파일은 제외. service_role 전용.';
