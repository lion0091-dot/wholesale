-- 주문별 원가·마진 조회 — 대표(owner) 전용.
--
-- 원가 = 이 주문으로 실제 나간 박스(재고 원장 기준)의 kg × 그 박스의 매입단가(inbound_scans.purchase_unit_price).
--   · 확정만 된 주문은 선입선출 자동 배정 박스 기준의 "예상", 출고 스캔·마감 후에는 실제로 집은 박스 기준이다
--     (원장이 배정 정정을 반영하므로 같은 계산으로 둘 다 맞는다).
--   · 박스 없는 재고분(수동 재고)·매입단가 미입력 박스의 kg는 원가 0으로 치지 않고 unpriced_qty로 따로 돌려준다.
--     화면이 "마진 미완성"으로 표시할 수 있게 하기 위함.
-- 권한: 대표 본인(wholesalers.profile_id)이거나 조직 owner만. 매니저·직원·고객·슈퍼관리자·비로그인은 거부.
--   (원가는 공급사의 영업 비밀이라 플랫폼 감독 계정에도 열지 않는다.)
create or replace function public.get_order_margin(p_order_id uuid)
returns table (
    product_id    uuid,
    product_name  text,
    unit          text,
    sold_qty      numeric,
    sales_amount  numeric,
    shipped_qty   numeric,
    cost_amount   numeric,
    unpriced_qty  numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_wholesaler_id uuid;
begin
    select o.wholesaler_id into v_wholesaler_id from public.orders o where o.id = p_order_id;

    if v_wholesaler_id is null then
        raise exception 'ORDER_NOT_FOUND';
    end if;

    if not (
        coalesce(v_wholesaler_id = public.get_current_wholesaler_id(), false)
        or public.is_org_staff_of_wholesaler(v_wholesaler_id, array['owner']::public.organization_role[])
    ) then
        raise exception 'NOT_OWNER';
    end if;

    return query
    with items as (
        select oi.product_id,
               max(oi.product_name) as product_name,
               sum(oi.quantity) as qty,
               sum(oi.subtotal_amount) as amount
        from public.order_items oi
        where oi.order_id = p_order_id
        group by oi.product_id
    ),
    net as (
        -- 이 주문에서 상품·박스별로 순수하게 나간 양(배정 정정·취소 원복 반영). apply_order_shipment의 계산식과 같은 이벤트 4종.
        select l.product_id, l.inbound_scan_id, -sum(l.qty_delta) as qty
        from public.stock_ledger l
        where l.source_type = 'order'
          and l.source_id = p_order_id
          and l.event_type in ('ORDER_OUT', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN', 'ORDER_RESTORE')
        group by l.product_id, l.inbound_scan_id
        having sum(l.qty_delta) <> 0
    ),
    cost as (
        select n.product_id,
               sum(n.qty) as shipped,
               coalesce(sum(n.qty * s.purchase_unit_price) filter (where s.purchase_unit_price is not null), 0) as cost_amount,
               coalesce(sum(n.qty) filter (where s.purchase_unit_price is null), 0) as unpriced
        from net n
        left join public.inbound_scans s on s.id = n.inbound_scan_id
        group by n.product_id
    )
    select it.product_id,
           it.product_name,
           p.unit,
           it.qty,
           it.amount,
           coalesce(c.shipped, 0),
           round(coalesce(c.cost_amount, 0), 0),
           coalesce(c.unpriced, 0)
    from items it
    left join public.products p on p.id = it.product_id
    left join cost c on c.product_id = it.product_id
    order by it.product_name;
end;
$$;

-- 새 SECURITY DEFINER 함수는 익명·PUBLIC 실행을 회수한다(202의 규칙). 로그인 사용자만, 안에서 대표 여부를 다시 검사한다.
revoke all on function public.get_order_margin(uuid) from public;
revoke all on function public.get_order_margin(uuid) from anon;
grant execute on function public.get_order_margin(uuid) to authenticated;
