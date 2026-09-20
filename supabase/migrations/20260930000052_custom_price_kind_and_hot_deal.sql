-- ====================================================================
-- 맞춤단가/핫딜 재설계: 상품 단위 "시크릿딜" 플래그를 없애고, 고객+상품
-- 매핑 단위로 "맞춤단가"와 "핫딜"을 완전히 독립된 건으로 관리한다.
--
-- 잠긴 설계 결정:
-- - custom_prices에 kind('custom'|'hot_deal')를 추가해, 같은 (고객,상품) 쌍이라도
--   맞춤단가 건과 핫딜 건이 동시에 따로 존재할 수 있다 (UNIQUE에 kind까지 포함).
-- - is_active로 매핑을 지우지 않고 껐다 켤 수 있다 — 핫딜은 재고 상황에 따라
--   자주 껐다 켜지므로, 끌 때마다 가격을 다시 입력하지 않아도 되게 하기 위함.
-- - products.is_secret_deal / secret_deal_visibility는 완전히 폐기한다. 이제
--   모든 상품은 "기본 상품"으로 항상 기준가에 노출되고, 매핑이 있고
--   is_active=true인 고객에게만 그 매핑 가격(+핫딜이면 강조 표시)으로 대체된다.
--   "노출 대상 지정"이라는 별도 개념/테이블은 없어진다 — 매핑의 존재+on 상태 자체가
--   노출 여부다.
-- ====================================================================

alter table public.custom_prices
    add column kind text not null default 'custom' check (kind in ('custom', 'hot_deal')),
    add column is_active boolean not null default true;

alter table public.custom_prices
    drop constraint custom_prices_retailer_id_product_id_key;
alter table public.custom_prices
    add constraint custom_prices_retailer_id_product_id_kind_key unique (retailer_id, product_id, kind);

comment on column public.custom_prices.kind is
    '''custom''(우수 단골 맞춤단가) 또는 ''hot_deal''(재고처분 핫딜). 같은 고객+상품 쌍이라도 종류별로 별도 행.';
comment on column public.custom_prices.is_active is
    '꺼두면(false) 가격 데이터는 보존한 채 그 고객에게는 기본 상품 정가로 되돌아간다.';

drop table if exists public.secret_deal_visibility;

alter table public.products drop column is_secret_deal;

-- get_row_audit_log 조회 대상 화이트리스트에서 secret_deal_visibility 제거
-- (파라미터/반환 타입은 20260930000051과 동일하므로 CREATE OR REPLACE로 대체)
create or replace function public.get_row_audit_log(
    p_wholesaler_id uuid,
    p_table_name    text,
    p_row_id        uuid,
    p_limit         int default 10,
    p_offset        int default 0
)
returns table(
    id          bigint,
    action      text,
    changed_by  uuid,
    old_data    jsonb,
    new_data    jsonb,
    created_at  timestamptz,
    total_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select a.id, a.action, a.changed_by, a.old_data, a.new_data, a.created_at,
           count(*) over () as total_count
      from public.audit_log a
     where a.table_name = p_table_name
       and a.row_id = p_row_id
       and p_table_name in ('products', 'custom_prices', 'orders')
       and coalesce(a.new_data, a.old_data) ->> 'wholesaler_id' = p_wholesaler_id::text
       and (
            exists (
                select 1 from public.wholesalers w
                 where w.id = p_wholesaler_id and w.profile_id = auth.uid()
            )
            or exists (
                select 1
                  from public.organization_staff s
                  join public.organizations o on o.id = s.organization_id
                 where o.wholesaler_id = p_wholesaler_id and s.user_id = auth.uid()
            )
            or public.get_current_role() = 'super_admin'
       )
     order by a.created_at desc
     limit greatest(p_limit, 0)
    offset greatest(p_offset, 0);
$$;

revoke all on function public.get_row_audit_log(uuid, text, uuid, int, int) from public;
grant execute on function public.get_row_audit_log(uuid, text, uuid, int, int) to authenticated;
