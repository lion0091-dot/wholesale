-- 6번 서류발행 DB 테스트(scripts/db-test-documents.sql)에서 나온 발견 2건 — 사장님 결정(2026-09-24)으로 수정.
--
-- 1) 계산서 중복발행 방어.
--    tax_invoice_issuances 에 주문당 유니크가 없고 발행 함수(issueTaxInvoice)에도 "이미 발행됨" 검사가 없어서,
--    발행 버튼을 두 번 누르면 문서관리번호가 매번 달라 국세청에 같은 주문의 계산서가 두 건 접수될 수 있었다.
--    "살아 있는 최초 발행이력"(pending 또는 issued) 은 주문당 하나만 허용한다.
--    - 정정 행(original_issuance_id 또는 modify_code 가 있는 행)은 세지 않는다 — 정정은 여러 번 가능하다.
--    - failed·cancelled 는 세지 않는다 — 실패한 발행은 다시 시도할 수 있다.
--    - pending 은 센다 — 서버가 응답 없이 끊겨 결과를 모르는 발행이 남아 있으면(실제로 국세청에 접수됐을 수 있음)
--      팝빌에서 확인해 정리하기 전까지 재발행을 막는 것이 이중 접수보다 안전하다.
--    라이브에 이미 같은 주문의 살아 있는 최초 이력이 둘 이상 있으면 이 인덱스 생성이 실패한다(팝빌 계약 전이라
--    없을 것으로 예상) — 그 경우 하나를 failed/cancelled 로 정리한 뒤 다시 적용.
--
-- 2) 매니저의 계산서 발행·조회.
--    서버 액션은 owner·manager 발행을 허용하는데(requireIssuerScope) 발행이력 정책은 사장 본인
--    (get_current_wholesaler_id)만 통과시켜, 매니저는 발행이력 생성이 RLS 로 거부되고 조회도 0건이었다.
--    owner·manager(can_manage_wholesaler 와 같은 기준) 로 넓힌다. 직원(staff)은 그대로 제외.
--    super_admin 은 조회 전용을 유지한다(WITH CHECK 에 넣지 않음).

CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_invoice_issuances_one_live_original
    ON public.tax_invoice_issuances (order_id)
    WHERE original_issuance_id IS NULL
      AND modify_code IS NULL
      AND status IN ('pending', 'issued');

COMMENT ON INDEX public.idx_tax_invoice_issuances_one_live_original IS
    '주문당 살아 있는(pending/issued) 최초 발행이력은 하나 — 계산서 이중 접수 방지(20260930000109). 정정 행·failed·cancelled 는 제외.';

DROP POLICY IF EXISTS "Tax invoice issuances manageable by owning wholesaler" ON public.tax_invoice_issuances;
DROP POLICY IF EXISTS "Tax invoice issuances manageable by owner or manager" ON public.tax_invoice_issuances;

CREATE POLICY "Tax invoice issuances manageable by owner or manager"
    ON public.tax_invoice_issuances
    FOR ALL
    USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[])
        OR public.get_current_role() = 'super_admin'
    )
    WITH CHECK (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[])
    );
