-- 재고 재설계 마이그 192(박스 합산 그림자 조회) 검증. 로컬 Docker DB 전용. 실행(전부 롤백):
--   (echo "begin;"; cat scripts/db-test-shadow-box-stock.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then raise exception 'FAIL: %', p_name; end if;
    raise notice 'PASS: %', p_name;
end $$;

insert into auth.users (id, email) values ('d3d3d3d3-0000-0000-0000-000000000001', 'shadow@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values ('d3d3d3d3-0000-0000-0000-000000000001', 'wholesaler', 'A', '010')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name)
    values ('d3d3d3d3-0000-0000-0000-0000000000a1', 'd3d3d3d3-0000-0000-0000-000000000001', '그림자축산', '1110000079', 'A');

-- 상품 3종(설계안 2-4): 등심 / 등심 1++ / 암소 등심 1++, 그리고 성별 조건만 있는 상품
insert into public.products (id, wholesaler_id, name, category, subcategory, origin, grade, sex, base_price, unit, stock_quantity, is_active) values
 ('d3d3d3d3-0000-0000-0000-0000000000b1','d3d3d3d3-0000-0000-0000-0000000000a1','한우 등심','소','등심','국내산',null,null,0,'kg',0,false),
 ('d3d3d3d3-0000-0000-0000-0000000000b2','d3d3d3d3-0000-0000-0000-0000000000a1','한우 등심 1++','소','등심','국내산','1++',null,0,'kg',0,false),
 ('d3d3d3d3-0000-0000-0000-0000000000b3','d3d3d3d3-0000-0000-0000-0000000000a1','한우 암소 등심 1++','소','등심','국내산','1++','암',0,'kg',0,false),
 ('d3d3d3d3-0000-0000-0000-0000000000b4','d3d3d3d3-0000-0000-0000-0000000000a1','한우 암소 등심','소','등심','국내산',null,'암',0,'kg',0,false);

-- 박스 A(로트·혼합 20kg) / B(개체 1++ 암 15kg) / C(개체 1+ 거세 18kg) / D(취소됨) / E(다른 부위)
insert into public.inbound_scans (id, wholesaler_id, trace_no, weight, remaining_weight, unit, scan_type, status) values
 ('d3d3d3d3-0000-0000-0000-0000000000c1','d3d3d3d3-0000-0000-0000-0000000000a1','L02011163016114',20,20,'kg','MANUAL','NORMAL'),
 ('d3d3d3d3-0000-0000-0000-0000000000c2','d3d3d3d3-0000-0000-0000-0000000000a1','002000000011',15,15,'kg','MANUAL','NORMAL'),
 ('d3d3d3d3-0000-0000-0000-0000000000c3','d3d3d3d3-0000-0000-0000-0000000000a1','002000000028',18,18,'kg','MANUAL','NORMAL'),
 ('d3d3d3d3-0000-0000-0000-0000000000c4','d3d3d3d3-0000-0000-0000-0000000000a1','002000000035',9,9,'kg','MANUAL','VOIDED'),
 ('d3d3d3d3-0000-0000-0000-0000000000c5','d3d3d3d3-0000-0000-0000-0000000000a1','002000000042',7,7,'kg','MANUAL','NORMAL');

-- 꼬리표는 직접 지정(트리거는 trace_no·product_id 변경 때만 돈다)
update public.inbound_scans set tag_species='소', tag_part='등심', tag_origin='국내산', tag_grade='혼합', tag_grade_mix='{"1++":5,"1+":2,"1":15}' where id='d3d3d3d3-0000-0000-0000-0000000000c1';
update public.inbound_scans set tag_species='소', tag_part='등심', tag_origin='국내산', tag_grade='1++', tag_sex='암', tag_bms='8' where id='d3d3d3d3-0000-0000-0000-0000000000c2';
update public.inbound_scans set tag_species='소', tag_part='등심', tag_origin='국내산', tag_grade='1+', tag_sex='거세' where id='d3d3d3d3-0000-0000-0000-0000000000c3';
update public.inbound_scans set tag_species='소', tag_part='등심', tag_origin='국내산', tag_grade='1++', tag_sex='암' where id='d3d3d3d3-0000-0000-0000-0000000000c4';
update public.inbound_scans set tag_species='소', tag_part='갈비', tag_origin='국내산', tag_grade='1+', tag_sex='암' where id='d3d3d3d3-0000-0000-0000-0000000000c5';

-- 서비스 세션(auth.uid 없음)에선 can_access_wholesaler가 막으므로 소유자 세션으로 호출
select set_config('request.jwt.claims', '{"sub":"d3d3d3d3-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

create temp table r as select * from public.shadow_box_stock('d3d3d3d3-0000-0000-0000-0000000000a1');
grant select on r to public;

do $$
declare x record;
begin
    select * into x from r where product_id='d3d3d3d3-0000-0000-0000-0000000000b1';
    perform pg_temp.expect('등심(조건 부위만): 확실 53kg 3박스 (A+B+C, 취소·갈비 제외)', x.sure_weight = 53 and x.sure_boxes = 3 and x.mixed_boxes = 0);

    select * into x from r where product_id='d3d3d3d3-0000-0000-0000-0000000000b2';
    perform pg_temp.expect('등심 1++: 확실 15kg(B), 열어봐야 아는 것 A 1박스 20kg(재고에 안 넣음)', x.sure_weight = 15 and x.sure_boxes = 1 and x.mixed_boxes = 1 and x.mixed_weight = 20);

    select * into x from r where product_id='d3d3d3d3-0000-0000-0000-0000000000b3';
    perform pg_temp.expect('암소 등심 1++: 확실 15kg(B). 성별 모르는 혼합 로트 A는 불일치(혼합에도 안 셈)', x.sure_weight = 15 and x.mixed_boxes = 0);

    select * into x from r where product_id='d3d3d3d3-0000-0000-0000-0000000000b4';
    perform pg_temp.expect('암소 등심(성별만): B만. 로트 A는 성별 모름이라 제외', x.sure_weight = 15 and x.sure_boxes = 1);

    select * into x from r where product_id='d3d3d3d3-0000-0000-0000-0000000000b1';
    perform pg_temp.expect('옛 방식 합(product_id 연결 없음)은 0 — 두 방식이 별개로 보인다', x.legacy_weight = 0);
end $$;

-- 같은 박스가 여러 상품에 동시에 센다(전제 4)
do $$
begin
    perform pg_temp.expect('박스 B(15kg)가 등심·등심1++·암소등심1++·암소등심 네 상품에 동시에 집계',
        (select count(*) from r where sure_weight >= 15) = 4);
end $$;

-- 권한: 다른 공급사 세션은 빈 결과
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000dead","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
    perform pg_temp.expect('남의 공급사 그림자 재고는 0행', (select count(*) from public.shadow_box_stock('d3d3d3d3-0000-0000-0000-0000000000a1')) = 0);
end $$;
