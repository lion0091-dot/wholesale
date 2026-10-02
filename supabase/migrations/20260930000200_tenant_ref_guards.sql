-- 200: 공급사 간 데이터 섞임 방어 (2026-10-02 격리 점검).
-- 발견: 공급사 A가 공급사 B의 상품 ID로 맞춤단가(custom_prices)를 만들 수 있었고, 그 값이 B 미니샵 가격 조회와
--       주문 검증 트리거(enforce_order_item_integrity, "활성 맞춤단가 중 하나면 통과")에 그대로 쓰였다. 운영 DB에는 섞인 행 0건(전수 조회).
-- 근본 원인: 상품·박스·거래처 등을 가리키는 컬럼이 "같은 공급사 소유"인지 DB가 강제하지 않았다(RLS와 RPC 게이트에만 의존).
-- 조치 1) 공급사 소유 참조 컬럼 전체에 enforce_tenant_refs 트리거 — 데이터 기반 단일 함수, 컬럼:부모표 쌍을 인자로 받는다.
--       2) tenant_consistency_violations() — 이미 섞인 행을 세는 점검 함수(서비스 전용, 일일 크론이 호출).
-- 규칙: 공급사 소유 표가 공급사 소유 표를 FK로 가리키면 이 트리거(또는 동등한 가드)가 있어야 한다 — scripts/db-test-tenant-guards.sql이 카탈로그로 검사한다.

create or replace function public.enforce_tenant_refs()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row     jsonb := to_jsonb(NEW);
    v_tenant  uuid;
    v_arg     text;
    v_col     text;
    v_parent  text;
    v_val     text;
    v_ptenant uuid;
begin
    v_tenant := nullif(v_row ->> 'wholesaler_id', '')::uuid;

    -- 맞춤단가처럼 공급사 대신 조직으로 소속을 표시하는 행은 조직의 공급사를 쓴다.
    if v_tenant is null and nullif(v_row ->> 'organization_id', '') is not null then
        select o.wholesaler_id into v_tenant from public.organizations o where o.id = (v_row ->> 'organization_id')::uuid;
    end if;

    -- 소속이 없는 행(플랫폼 공용)은 검사 대상이 아니다.
    if v_tenant is null then
        return NEW;
    end if;

    foreach v_arg in array TG_ARGV loop
        v_col := split_part(v_arg, ':', 1);
        v_parent := split_part(v_arg, ':', 2);
        v_val := nullif(v_row ->> v_col, '');

        if v_val is null then
            continue;
        end if;

        v_ptenant := null;
        execute format('select wholesaler_id from public.%I where id = $1', v_parent) into v_ptenant using v_val::uuid;

        if v_ptenant is not null and v_ptenant <> v_tenant then
            raise exception 'TENANT_REF_MISMATCH:%.%', TG_TABLE_NAME, v_col using errcode = '23514';
        end if;
    end loop;

    return NEW;
end;
$$;

revoke all on function public.enforce_tenant_refs() from public, anon, authenticated;

drop trigger if exists trg_custom_prices_tenant_refs on public.custom_prices;
create trigger trg_custom_prices_tenant_refs before insert or update of wholesaler_id, product_id, organization_id on public.custom_prices
    for each row execute function public.enforce_tenant_refs('product_id:products', 'organization_id:organizations');

drop trigger if exists trg_gtin_product_map_tenant_refs on public.gtin_product_map;
create trigger trg_gtin_product_map_tenant_refs before insert or update of wholesaler_id, product_id on public.gtin_product_map
    for each row execute function public.enforce_tenant_refs('product_id:products');

drop trigger if exists trg_inbound_rejections_tenant_refs on public.inbound_rejections;
create trigger trg_inbound_rejections_tenant_refs before insert or update of wholesaler_id, product_id, scan_id, supplier_id on public.inbound_rejections
    for each row execute function public.enforce_tenant_refs('product_id:products', 'scan_id:inbound_scans', 'supplier_id:suppliers');

drop trigger if exists trg_inbound_scans_tenant_refs on public.inbound_scans;
create trigger trg_inbound_scans_tenant_refs before insert or update of wholesaler_id, parent_scan_id, product_id, supplier_id on public.inbound_scans
    for each row execute function public.enforce_tenant_refs('parent_scan_id:inbound_scans', 'product_id:products', 'supplier_id:suppliers');

drop trigger if exists trg_livestock_exception_log_tenant_refs on public.livestock_exception_log;
create trigger trg_livestock_exception_log_tenant_refs before insert or update of wholesaler_id, inbound_scan_id on public.livestock_exception_log
    for each row execute function public.enforce_tenant_refs('inbound_scan_id:inbound_scans');

drop trigger if exists trg_outbound_sms_queue_tenant_refs on public.outbound_sms_queue;
create trigger trg_outbound_sms_queue_tenant_refs before insert or update of wholesaler_id, invoice_id on public.outbound_sms_queue
    for each row execute function public.enforce_tenant_refs('invoice_id:platform_subscription_invoices');

drop trigger if exists trg_product_purchase_prices_tenant_refs on public.product_purchase_prices;
create trigger trg_product_purchase_prices_tenant_refs before insert or update of wholesaler_id, product_id on public.product_purchase_prices
    for each row execute function public.enforce_tenant_refs('product_id:products');

drop trigger if exists trg_purchase_order_line_scans_tenant_refs on public.purchase_order_line_scans;
create trigger trg_purchase_order_line_scans_tenant_refs before insert or update of wholesaler_id, line_id, scan_id on public.purchase_order_line_scans
    for each row execute function public.enforce_tenant_refs('line_id:purchase_order_lines', 'scan_id:inbound_scans');

drop trigger if exists trg_stock_ledger_tenant_refs on public.stock_ledger;
create trigger trg_stock_ledger_tenant_refs before insert or update of wholesaler_id, inbound_scan_id, product_id on public.stock_ledger
    for each row execute function public.enforce_tenant_refs('inbound_scan_id:inbound_scans', 'product_id:products');

drop trigger if exists trg_supplier_statement_files_tenant_refs on public.supplier_statement_files;
create trigger trg_supplier_statement_files_tenant_refs before insert or update of wholesaler_id, supplier_id on public.supplier_statement_files
    for each row execute function public.enforce_tenant_refs('supplier_id:suppliers');

drop trigger if exists trg_tax_invoice_issuances_tenant_refs on public.tax_invoice_issuances;
create trigger trg_tax_invoice_issuances_tenant_refs before insert or update of wholesaler_id, order_id, original_issuance_id on public.tax_invoice_issuances
    for each row execute function public.enforce_tenant_refs('order_id:orders', 'original_issuance_id:tax_invoice_issuances');

drop trigger if exists trg_trace_product_map_tenant_refs on public.trace_product_map;
create trigger trg_trace_product_map_tenant_refs before insert or update of wholesaler_id, product_id on public.trace_product_map
    for each row execute function public.enforce_tenant_refs('product_id:products');

-- 이미 섞인 행을 세는 점검. 0이 아닌 줄이 있으면 섞임이다. 서비스 전용(일일 크론 /api/cron/check-tenant-consistency).
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
$$;

revoke all on function public.tenant_consistency_violations() from public, anon, authenticated;
grant execute on function public.tenant_consistency_violations() to service_role;
