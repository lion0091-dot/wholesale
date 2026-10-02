-- 전표·전표 줄 조회 정책(212)이 예전과 접근 범위가 똑같은지 — 빨라졌어도 더 넓어지거나 좁아지면 안 된다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-po-view-policy.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text;
begin
    execute p_sql into v;
    return coalesce(v, '<null>');
exception when others then
    return 'ERROR: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- 98 시드: 01 대표A / 02 매니저A / 03 직원A / 04 대표B / 05 슈퍼관리자 / 06 고객 / 07 소속 없는 사람
insert into auth.users (id,email) values
 ('98999999-0000-0000-0000-000000000001','owner-a@pov.test'),
 ('98999999-0000-0000-0000-000000000002','manager-a@pov.test'),
 ('98999999-0000-0000-0000-000000000003','staff-a@pov.test'),
 ('98999999-0000-0000-0000-000000000004','owner-b@pov.test'),
 ('98999999-0000-0000-0000-000000000005','admin@pov.test'),
 ('98999999-0000-0000-0000-000000000006','retailer@pov.test'),
 ('98999999-0000-0000-0000-000000000007','nobody@pov.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('98999999-0000-0000-0000-000000000001','wholesaler','A대표','010',true,true),
 ('98999999-0000-0000-0000-000000000002','wholesaler','A매니저','010',true,true),
 ('98999999-0000-0000-0000-000000000003','wholesaler','A직원','010',true,true),
 ('98999999-0000-0000-0000-000000000004','wholesaler','B대표','010',true,true),
 ('98999999-0000-0000-0000-000000000005','super_admin','운영자','010',false,false),
 ('98999999-0000-0000-0000-000000000006','retailer','식당','010',false,false),
 ('98999999-0000-0000-0000-000000000007','wholesaler','무소속','010',true,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a8999999-0000-0000-0000-000000000001','98999999-0000-0000-0000-000000000001','A축산','9890000001','A','active'),
 ('a8999999-0000-0000-0000-000000000002','98999999-0000-0000-0000-000000000004','B축산','9890000002','B','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('08999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001','A축산','9890000001'),
 ('08999999-0000-0000-0000-000000000002','a8999999-0000-0000-0000-000000000002','B축산','9890000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('08999999-0000-0000-0000-000000000001','98999999-0000-0000-0000-000000000001','owner'),
 ('08999999-0000-0000-0000-000000000001','98999999-0000-0000-0000-000000000002','manager'),
 ('08999999-0000-0000-0000-000000000001','98999999-0000-0000-0000-000000000003','staff'),
 ('08999999-0000-0000-0000-000000000002','98999999-0000-0000-0000-000000000004','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d8999999-0000-0000-0000-000000000001','98999999-0000-0000-0000-000000000006','식당','사장','서울');
insert into public.suppliers (id,wholesaler_id,name) values
 ('e8999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001','A공급처'),
 ('e8999999-0000-0000-0000-000000000002','a8999999-0000-0000-0000-000000000002','B공급처');
insert into public.purchase_orders (id,wholesaler_id,supplier_id,supplier_name,ordered_on,status) values
 ('f8999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001','e8999999-0000-0000-0000-000000000001','A공급처',current_date,'OPEN'),
 ('f8999999-0000-0000-0000-000000000002','a8999999-0000-0000-0000-000000000002','e8999999-0000-0000-0000-000000000002','B공급처',current_date,'OPEN');
insert into public.purchase_order_lines (purchase_order_id,wholesaler_id,line_no,category,subcategory,grade,origin,quantity,unit) values
 ('f8999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001',1,'소','등심','1+','국내산',10,'kg'),
 ('f8999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001',2,'소','안심','1+','국내산',10,'kg'),
 ('f8999999-0000-0000-0000-000000000002','a8999999-0000-0000-0000-000000000002',1,'소','등심','1+','국내산',10,'kg');

-- 보는 사람마다 (전표 수 | A사 전표 수 | B사 전표 수 | 줄 수 | A사 줄 수) 를 센다
create function pg_temp.sees(p_sub text) returns text language plpgsql as $$
declare v text;
begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select (select count(*) from public.purchase_orders where id::text like 'f8999999%')
        || '|' || (select count(*) from public.purchase_orders where wholesaler_id = 'a8999999-0000-0000-0000-000000000001')
        || '|' || (select count(*) from public.purchase_orders where wholesaler_id = 'a8999999-0000-0000-0000-000000000002')
        || '|' || (select count(*) from public.purchase_order_lines where wholesaler_id::text like 'a8999999%')
        || '|' || (select count(*) from public.purchase_order_lines where wholesaler_id = 'a8999999-0000-0000-0000-000000000001')
      into v;
    reset role;
    return v;
exception when others then
    reset role;
    return 'ERROR: ' || sqlerrm;
end $$;

insert into results (who,what,expected,result) values
 ('A대표','자기 업체만: 전표 1·A1·B0, 줄 2·A2','1|1|0|2|2', pg_temp.sees('98999999-0000-0000-0000-000000000001')),
 ('A매니저','같은 업체 직원도 A사 전표·줄을 본다(읽기 범위는 예전과 같다)','1|1|0|2|2', pg_temp.sees('98999999-0000-0000-0000-000000000002')),
 ('A직원','일반 직원도 A사 전표·줄을 본다','1|1|0|2|2', pg_temp.sees('98999999-0000-0000-0000-000000000003')),
 ('B대표','B사 것만: 전표 1·A0·B1, 줄 1·A0','1|0|1|1|0', pg_temp.sees('98999999-0000-0000-0000-000000000004')),
 ('운영자','슈퍼관리자는 둘 다 본다(기존 검사가 그대로 판정): 전표 2, 줄 3','2|1|1|3|2', pg_temp.sees('98999999-0000-0000-0000-000000000005')),
 ('고객','고객은 전표를 못 본다','0|0|0|0|0', pg_temp.sees('98999999-0000-0000-0000-000000000006')),
 ('무소속','업체·조직에 속하지 않은 사람은 못 본다','0|0|0|0|0', pg_temp.sees('98999999-0000-0000-0000-000000000007'));

-- 소속이 바뀌면 바로 반영된다: 직원이 조직에서 빠지면 못 본다
delete from public.organization_staff where user_id = '98999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원(탈퇴 후)','조직에서 빠진 직원은 더 이상 못 본다','0|0|0|0|0', pg_temp.sees('98999999-0000-0000-0000-000000000003'));

-- 익명은 예전처럼 아무 행도 못 본다
set local role anon;
set local request.jwt.claim.sub = '';
insert into results (who,what,expected,result) values
 ('비로그인','익명은 전표 조회 → 0건 또는 거부','ok', case when pg_temp.val($q$select count(*)::text from public.purchase_order_lines$q$) in ('0') or pg_temp.val($q$select count(*)::text from public.purchase_order_lines$q$) like 'ERROR:%' then 'ok' else 'LEAK' end);
reset role;

select '--- 결과 ---' as t;
select no, who, what, expected, result, case when result = expected then 'PASS' else 'FAIL' end as verdict from results order by no;
select count(*) filter (where result = expected) as pass, count(*) filter (where result <> expected) as fail from results;
