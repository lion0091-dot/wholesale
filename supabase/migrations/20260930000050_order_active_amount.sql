-- 주문 관리 화면 상단 "누적 발주 금액(취소 제외)" 카드용 집계 RPC.
--
-- 주문 목록 자체는 이제 배송완료/취소 같은 "끝난" 상태를 조회 구간(기본 최근 30일)으로
-- 제한해서 불러온다(app/dashboard/orders/page.tsx) — 매일 쌓이기만 하는 주문을 화면 열 때마다
-- 통째로 가져오지 않기 위해서다. 하지만 그렇다고 "누적 발주 금액" 카드까지 최근 30일치로
-- 줄어들면 안 된다 — 이건 그대로 전체 기간 합계여야 의미가 있다. 행 데이터를 전부 내려받지
-- 않고 SUM만 서버에서 계산해서 반환하면 되므로, 목록 페이지네이션과는 별개로 가벼운
-- 집계 쿼리 하나를 둔다.
create or replace function public.get_order_active_amount(p_wholesaler_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(sum(o.total_amount), 0)
      from public.orders o
     where o.wholesaler_id = p_wholesaler_id
       and o.status <> 'cancelled'
       and (
            exists (
                select 1 from public.wholesalers w
                 where w.id = p_wholesaler_id and w.profile_id = auth.uid()
            )
            or exists (
                select 1
                  from public.organization_staff s
                  join public.organizations o2 on o2.id = s.organization_id
                 where o2.wholesaler_id = p_wholesaler_id and s.user_id = auth.uid()
            )
            or public.get_current_role() = 'super_admin'
       );
$$;

revoke all on function public.get_order_active_amount(uuid) from public;
grant execute on function public.get_order_active_amount(uuid) to authenticated;
