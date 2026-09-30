-- 170: 5년 파기 보강 2건 (2026-09-30, 사장님 승인 "차례대로")
--  (1) 변경 이력(audit_log)에 복사돼 남던 옛 주문·거래처 스냅샷을 파기 대상 계정 것에 한해 함께 삭제
--  (2) 입점 희망 문의(retailer_match_requests)를 접수 1년 뒤 삭제 — 기간은 match_request_retention() 한 곳에서 정한다
-- 169의 함수 본문에 위 블록만 더했다.

CREATE OR REPLACE FUNCTION public.match_request_retention()
RETURNS INTERVAL LANGUAGE sql IMMUTABLE AS $$ SELECT interval '1 year' $$;

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

    -- 2-1b) 변경 이력(audit_log)에 통째로 복사돼 있는 옛 주문·거래처 스냅샷(배송지·메모 등)도 함께 지운다.
    --       위 UPDATE가 방금 남긴 "바꾸기 전" 스냅샷도 여기서 지워지도록 반드시 UPDATE 뒤에 둔다.
    DELETE FROM public.audit_log a
     WHERE a.table_name = 'orders'
       AND a.row_id IN (SELECT o.id FROM public.orders o
                         WHERE o.wholesaler_id = ANY(v_wholesalers) OR o.retailer_id = ANY(v_retailers));

    DELETE FROM public.audit_log a
     WHERE a.table_name = 'wholesaler_retailers'
       AND ((COALESCE(a.new_data, a.old_data) ->> 'wholesaler_id')::uuid = ANY(v_wholesalers)
            OR (COALESCE(a.new_data, a.old_data) ->> 'retailer_id')::uuid = ANY(v_retailers));

    -- 2-2) 탈퇴 고객의 상호·사업자번호·대표자명·주소 (168부터 탈퇴 즉시에는 상호·사업자번호를 남긴다)
    UPDATE public.retailers r
       SET restaurant_name = '(파기됨)',
           representative_name = '(파기됨)',
           business_number = NULL,
           delivery_address = '',
           delivery_address_detail = NULL
     WHERE r.id = ANY(v_retailers)
       AND (r.restaurant_name <> '(파기됨)' OR r.business_number IS NOT NULL OR r.delivery_address <> '');

    -- 2-3) 공급사가 입력한 발주처(상위 공급처)의 연락처·메모 — 발주처 행은 발주서·입고 스캔이 참조하므로
    --      지우지 않고 상호·별칭만 남긴다(매입 기록 식별용). 발주처는 한 공급사에만 속한다(wholesaler_id).
    UPDATE public.suppliers sp
       SET phone = NULL,
           note = NULL
     WHERE sp.wholesaler_id = ANY(v_wholesalers)
       AND (sp.phone IS NOT NULL OR sp.note IS NOT NULL);

    -- 2-4) 입점 희망 문의(비로그인 방문자가 남긴 이름·연락처): 접수 후 1년이 지나면 삭제
    DELETE FROM public.retailer_match_requests m
     WHERE m.created_at < now() - public.match_request_retention();

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

