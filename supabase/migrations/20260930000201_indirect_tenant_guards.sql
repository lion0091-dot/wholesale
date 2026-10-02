-- 201: 소유 컬럼(wholesaler_id)이 없고 부모 표를 통해서만 소속이 정해지는 "자식 표"의 교차 소속 가드 (2026-10-02 ERD 점검).
-- 200은 wholesaler_id가 있는 표만 막았다. ERD를 소유 기준으로 분류하면 소유 컬럼 없는 표 중 부모 2곳 이상을 가리키는 표는
-- order_items(주문·상품, 이미 trg_order_items_integrity가 있음)와 inbound_import_rows(업로드 작업·박스) 둘뿐이고, 뒤쪽이 비어 있었다.
-- inbound_import_rows.scan_id는 앱에서 쓰기만 하고 읽어서 동작하는 곳이 없어 실제 위험은 낮았지만, 다른 공급사 박스를 가리킬 수 있는 구조적 틈이라 막는다.
-- 운영 DB에 이미 섞인 행은 없음(점검 함수 확장분 포함 0건 — 적용 전 확인).

create or replace function public.enforce_import_row_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_job_tenant  uuid;
    v_scan_tenant uuid;
begin
    if NEW.scan_id is null then
        return NEW;
    end if;

    select j.wholesaler_id into v_job_tenant from public.inbound_import_jobs j where j.id = NEW.job_id;
    select s.wholesaler_id into v_scan_tenant from public.inbound_scans s where s.id = NEW.scan_id;

    if v_job_tenant is not null and v_scan_tenant is not null and v_job_tenant <> v_scan_tenant then
        raise exception 'TENANT_REF_MISMATCH:inbound_import_rows.scan_id' using errcode = '23514';
    end if;

    return NEW;
end;
$$;

revoke all on function public.enforce_import_row_tenant() from public, anon, authenticated;

drop trigger if exists trg_inbound_import_rows_tenant on public.inbound_import_rows;
create trigger trg_inbound_import_rows_tenant before insert or update of job_id, scan_id on public.inbound_import_rows
    for each row execute function public.enforce_import_row_tenant();

-- 점검 함수에 같은 검사를 추가(기존 23항목 + 1). 본문은 200의 정의에 한 줄을 더한 것이다.
create or replace function public.tenant_consistency_violations()
returns table(ref text, violations bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select 'custom_prices.product_id'::text, count(*) from public.custom_prices c join public.products p on p.id = c.product_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'gtin_product_map.product_id'::text, count(*) from public.gtin_product_map c join public.products p on p.id = c.product_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'inbound_rejections.product_id'::text, count(*) from public.inbound_rejections c join public.products p on p.id = c.product_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'inbound_rejections.scan_id'::text, count(*) from public.inbound_rejections c join public.inbound_scans p on p.id = c.scan_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'inbound_rejections.supplier_id'::text, count(*) from public.inbound_rejections c join public.suppliers p on p.id = c.supplier_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'inbound_scans.parent_scan_id'::text, count(*) from public.inbound_scans c join public.inbound_scans p on p.id = c.parent_scan_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'inbound_scans.product_id'::text, count(*) from public.inbound_scans c join public.products p on p.id = c.product_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'inbound_scans.supplier_id'::text, count(*) from public.inbound_scans c join public.suppliers p on p.id = c.supplier_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'livestock_exception_log.inbound_scan_id'::text, count(*) from public.livestock_exception_log c join public.inbound_scans p on p.id = c.inbound_scan_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'outbound_sms_queue.invoice_id'::text, count(*) from public.outbound_sms_queue c join public.platform_subscription_invoices p on p.id = c.invoice_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'product_purchase_prices.product_id'::text, count(*) from public.product_purchase_prices c join public.products p on p.id = c.product_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'purchase_order_line_scans.line_id'::text, count(*) from public.purchase_order_line_scans c join public.purchase_order_lines p on p.id = c.line_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'purchase_order_line_scans.scan_id'::text, count(*) from public.purchase_order_line_scans c join public.inbound_scans p on p.id = c.scan_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'stock_ledger.inbound_scan_id'::text, count(*) from public.stock_ledger c join public.inbound_scans p on p.id = c.inbound_scan_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'stock_ledger.product_id'::text, count(*) from public.stock_ledger c join public.products p on p.id = c.product_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'supplier_statement_files.supplier_id'::text, count(*) from public.supplier_statement_files c join public.suppliers p on p.id = c.supplier_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'tax_invoice_issuances.order_id'::text, count(*) from public.tax_invoice_issuances c join public.orders p on p.id = c.order_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'tax_invoice_issuances.original_issuance_id'::text, count(*) from public.tax_invoice_issuances c join public.tax_invoice_issuances p on p.id = c.original_issuance_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'trace_product_map.product_id'::text, count(*) from public.trace_product_map c join public.products p on p.id = c.product_id where c.wholesaler_id is not null and p.wholesaler_id is not null and p.wholesaler_id <> c.wholesaler_id
    union all
    select 'custom_prices(조직).product_id'::text, count(*) from public.custom_prices c join public.products p on p.id = c.product_id join public.organizations o on o.id = c.organization_id where c.wholesaler_id is null and o.wholesaler_id <> p.wholesaler_id
    union all
    select 'order_items.product_id'::text, count(*) from public.order_items i join public.orders o on o.id = i.order_id join public.products p on p.id = i.product_id where p.wholesaler_id <> o.wholesaler_id
    union all
    select 'purchase_order_lines.product_id'::text, count(*) from public.purchase_order_lines l join public.products p on p.id = l.product_id where p.wholesaler_id <> l.wholesaler_id
    union all
    select 'orders.거래처연결없음'::text, count(*) from public.orders o where not exists (select 1 from public.wholesaler_retailers wr where wr.wholesaler_id = o.wholesaler_id and wr.retailer_id = o.retailer_id)
    union all
    select 'inbound_import_rows.scan_id'::text, count(*) from public.inbound_import_rows r join public.inbound_import_jobs j on j.id = r.job_id join public.inbound_scans s on s.id = r.scan_id where j.wholesaler_id <> s.wholesaler_id;
$$;

revoke all on function public.tenant_consistency_violations() from public, anon, authenticated;
grant execute on function public.tenant_consistency_violations() to service_role;
