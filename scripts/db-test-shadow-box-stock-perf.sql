-- 마이그 196(shadow_box_stock 성능) 검증: 옛 함수(192)와 결과 양방향 비교 + 규모 부하(박스 5,000·과거 박스 3만·상품 52).
-- 로컬 Docker DB 전용. 192·195(남은 중량 0 박스 제외까지 고친 옛 함수)를 먼저 적용해 shadow_box_stock_old로 바꿔 둔 뒤 196을 적용한다.
-- 192 원본은 남은 중량 0 박스까지 세는 버그(코드리뷰 3번)가 있어 비교 기준이 될 수 없다. 실행(전부 롤백):
--   (echo "begin;"; cat supabase/migrations/20260930000192_stock_redesign_shadow_box_stock.sql supabase/migrations/20260930000195_code_review_fixes.sql; echo "alter function public.shadow_box_stock(uuid) rename to shadow_box_stock_old;"; cat supabase/migrations/20260930000196_shadow_box_stock_perf.sql scripts/db-test-shadow-box-stock-perf.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then raise exception 'FAIL: %', p_name; end if;
    raise notice 'PASS: %', p_name;
end $$;

insert into auth.users (id, email) values ('b7b7b7b7-0000-0000-0000-000000000001', 'perf@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values ('b7b7b7b7-0000-0000-0000-000000000001', 'wholesaler', 'A', '010') on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name)
 values ('b7b7b7b7-0000-0000-0000-0000000000a1', 'b7b7b7b7-0000-0000-0000-000000000001', '부하축산', '1110000085', 'A');

-- 상품 50개(부위 10 × 등급 5) + 조건이 느슨한 상품 2개(부위만, 없는 부위) — NULL 조건 경로도 비교한다.
insert into public.products (wholesaler_id, name, category, subcategory, origin, grade, breed, storage_state, base_price, unit, stock_quantity, is_active)
select 'b7b7b7b7-0000-0000-0000-0000000000a1', 'P' || p || '-' || g, '소', '부위' || p, '국내산', (array['1++','1+','1','2','3'])[g], '한우', '냉장', 0, 'kg', 0, false
  from generate_series(1,10) p, generate_series(1,5) g;
insert into public.products (wholesaler_id, name, category, subcategory, origin, base_price, unit, stock_quantity, is_active) values
 ('b7b7b7b7-0000-0000-0000-0000000000a1', '느슨-부위만', '소', '부위3', '국내산', 0, 'kg', 0, false),
 ('b7b7b7b7-0000-0000-0000-0000000000a1', '느슨-없는부위', '소', '없는부위', '국내산', 0, 'kg', 0, false);

insert into public.inbound_scans (wholesaler_id, trace_no, product_id, weight, remaining_weight, unit, scan_type, status,
                                  tag_species, tag_part, tag_origin, tag_grade, tag_sex, tag_breed, tag_storage_state)
select 'b7b7b7b7-0000-0000-0000-0000000000a1', 'T' || lpad(i::text, 11, '0'),
       (select id from public.products where wholesaler_id = 'b7b7b7b7-0000-0000-0000-0000000000a1' and name like 'P%' order by name offset (i % 50) limit 1),
       20, case when i <= 5000 then 20 else 0 end, 'kg', 'MANUAL', 'NORMAL',
       '소', '부위' || (1 + (i % 10)), '국내산', (array['1++','1+','1','2','3','혼합', null])[1 + (i % 7)],
       case when i % 3 = 0 then '암' end, '한우', '냉장'
  from generate_series(1, 35000) i;
analyze public.inbound_scans;
analyze public.products;

select set_config('request.jwt.claims', '{"sub":"b7b7b7b7-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

-- 1) 옛 함수와 양방향 비교(행·값 모두 같아야 한다)
select pg_temp.expect('옛 함수와 새 함수 결과가 양방향으로 완전히 같다(52행)',
    (select count(*) from public.shadow_box_stock('b7b7b7b7-0000-0000-0000-0000000000a1')) = 52
    and not exists (select * from public.shadow_box_stock_old('b7b7b7b7-0000-0000-0000-0000000000a1')
                    except select * from public.shadow_box_stock('b7b7b7b7-0000-0000-0000-0000000000a1'))
    and not exists (select * from public.shadow_box_stock('b7b7b7b7-0000-0000-0000-0000000000a1')
                    except select * from public.shadow_box_stock_old('b7b7b7b7-0000-0000-0000-0000000000a1')));

-- 2) 규모 상한: 옛 방식은 2초대. 새 방식은 0.3초 안이어야 한다.
do $$
declare t0 timestamptz; ms numeric;
begin
    t0 := clock_timestamp();
    perform count(*) from public.shadow_box_stock('b7b7b7b7-0000-0000-0000-0000000000a1');
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    perform pg_temp.expect('박스 5,000·상품 52개에서 300ms 이내(실측 ' || round(ms) || 'ms)', ms < 300);
end $$;
