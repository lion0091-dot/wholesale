-- 계산서(면세) 국세청 실제 발행(팝빌 연동). 지금까진 "PDF만 만들고 DB에 저장 안 함"이었지만,
-- 실제 신고부터는 정정(수정계산서) 시 원본 문서를 찾아야 하고 발행 상태를 추적해야 해서
-- 발행 이력 테이블이 새로 필요하다.
--
-- popbill_mgt_key: 팝빌 문서관리번호(MgtKeyType=SELL, 우리가 발급해서 registIssue에 넘김).
-- popbill_nts_confirm_num: 국세청 승인번호. 발행 성공 후 팝빌 응답으로 채워진다(실패 시 NULL).
-- modify_code: 국세청 표준 수정사유 코드(1~6, docs/tax-invoice-draft.md 참고). 최초 발행은
-- NULL, 정정 발행만 채운다.
-- original_issuance_id: 정정 발행이 참조하는 원본 발행 row(self FK). 최초 발행은 NULL.
-- wholesaler_id를 orders에서 다시 조회하지 않고 이 테이블에 직접 들고 있는 이유는 RLS 정책을
-- orders 서브쿼리 없이 바로 걸기 위함(다른 wholesaler-scoped 테이블과 동일 패턴).
create table public.tax_invoice_issuances (
    id                     uuid primary key default gen_random_uuid(),
    order_id               uuid not null references public.orders(id) on delete cascade,
    wholesaler_id          uuid not null references public.wholesalers(id) on delete cascade,
    original_issuance_id   uuid references public.tax_invoice_issuances(id) on delete set null,
    popbill_mgt_key        text not null,
    popbill_nts_confirm_num text,
    tax_type               text not null default '면세' check (tax_type = '면세'),
    modify_code            smallint check (modify_code between 1 and 6),
    status                 text not null default 'pending' check (status in ('pending', 'issued', 'failed', 'cancelled')),
    error_message          text,
    issued_at              timestamptz,
    created_by             uuid references auth.users(id) on delete set null default auth.uid(),
    created_at             timestamptz not null default now(),
    unique (wholesaler_id, popbill_mgt_key)
);

create index idx_tax_invoice_issuances_order on public.tax_invoice_issuances(order_id);
create index idx_tax_invoice_issuances_wholesaler on public.tax_invoice_issuances(wholesaler_id);
create index idx_tax_invoice_issuances_original on public.tax_invoice_issuances(original_issuance_id);

alter table public.tax_invoice_issuances enable row level security;

-- 계산서는 공급자(wholesaler)가 발행 주체 — 거래명세서/계산서 도우미와 동일하게 바이어 화면
-- 없음(docs/tax-invoice-draft.md 잠긴 설계 결정). super_admin은 CS 대응용으로 조회만 허용.
create policy "Tax invoice issuances manageable by owning wholesaler" on public.tax_invoice_issuances
    for all using (
        wholesaler_id = public.get_current_wholesaler_id()
        or public.get_current_role() = 'super_admin'
    )
    with check (wholesaler_id = public.get_current_wholesaler_id());

-- 팝빌 연동회원 가입 상태. 공급사가 팝빌에 직접 가입하는 게 아니라 최초 발행 시도 시
-- joinMember로 우리가 자동 가입시키므로(docs/tax-invoice-nts-filing.md 참고), 가입 여부와
-- 팝빌 로그인 ID(우리가 생성해 전달)만 저장하면 된다.
alter table public.wholesalers
    add column popbill_member_id  text,
    add column popbill_joined_at  timestamptz;
