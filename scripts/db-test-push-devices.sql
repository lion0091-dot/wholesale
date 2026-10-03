-- 알림을 켠 기기 목록(226) — 대표·매니저만, 같은 업체 기기만, 푸시 주소·키는 안 내려줌, 최신 사용순.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-push-devices.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ALLOWED'; exception when others then return 'DENIED: ' || split_part(sqlerrm, ':', 1); end $$;
create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return coalesce(v, '<null>'); exception when others then return 'ERROR: ' || split_part(sqlerrm, ':', 1); end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- 시드: 01 대표 / 02 매니저 / 03 직원 / 04 타사 대표
insert into auth.users (id,email) values
 ('9d999999-9d99-0000-0000-000000000001','owner@pushdev.test'),
 ('9d999999-9d99-0000-0000-000000000002','manager@pushdev.test'),
 ('9d999999-9d99-0000-0000-000000000003','staff@pushdev.test'),
 ('9d999999-9d99-0000-0000-000000000004','other@pushdev.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('9d999999-9d99-0000-0000-000000000001','wholesaler','대표','010',true,true),
 ('9d999999-9d99-0000-0000-000000000002','wholesaler','매니저','010',true,true),
 ('9d999999-9d99-0000-0000-000000000003','wholesaler','직원','010',true,true),
 ('9d999999-9d99-0000-0000-000000000004','wholesaler','타사대표','010',true,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a9d99999-0000-0000-0000-000000000001','9d999999-9d99-0000-0000-000000000001','기기축산','9d90000001','대표','active'),
 ('a9d99999-0000-0000-0000-000000000002','9d999999-9d99-0000-0000-000000000004','타사축산','9d90000002','타사','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('09d99999-0000-0000-0000-000000000001','a9d99999-0000-0000-0000-000000000001','기기축산','9d90000001'),
 ('09d99999-0000-0000-0000-000000000002','a9d99999-0000-0000-0000-000000000002','타사축산','9d90000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('09d99999-0000-0000-0000-000000000001','9d999999-9d99-0000-0000-000000000001','owner'),
 ('09d99999-0000-0000-0000-000000000001','9d999999-9d99-0000-0000-000000000002','manager'),
 ('09d99999-0000-0000-0000-000000000001','9d999999-9d99-0000-0000-000000000003','staff'),
 ('09d99999-0000-0000-0000-000000000002','9d999999-9d99-0000-0000-000000000004','owner');

-- 기기: 대표 폰(어제 알림 받음), 직원 PC(켠 뒤 아직 못 받음), 타사 대표 기기
insert into public.push_subscriptions (user_id,wholesaler_id,endpoint,p256dh,auth,user_agent,created_at,last_used_at) values
 ('9d999999-9d99-0000-0000-000000000001','a9d99999-0000-0000-0000-000000000001','https://push.example/a1','k1','a1','Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1', now() - interval '10 days', now() - interval '1 day'),
 ('9d999999-9d99-0000-0000-000000000003','a9d99999-0000-0000-0000-000000000001','https://push.example/a2','k2','a2','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', now() - interval '2 days', null),
 ('9d999999-9d99-0000-0000-000000000004','a9d99999-0000-0000-0000-000000000002','https://push.example/b1','k3','a3','Mozilla/5.0 (Linux; Android 14) Chrome/124.0 Mobile Safari/537.36', now(), now());

set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '9d999999-9d99-0000-0000-000000000001';

insert into results (who,what,expected,result) values
 ('대표','우리 업체 기기 2대만, 최근 사용 순(대표 폰 → 직원 PC), 타사 기기는 없다','2|대표|직원', pg_temp.val($q$select count(*)||'|'||min(user_name) filter (where rn=1)||'|'||min(user_name) filter (where rn=2) from (select user_name, row_number() over () rn from public.list_push_devices()) x$q$)),
 ('대표','아직 알림을 못 받은 기기도 나온다(last_used_at 비어 있음)','1', pg_temp.val($q$select count(*)::text from public.list_push_devices() where last_used_at is null$q$)),
 ('대표','반환 컬럼은 5개뿐(device_id,user_name,user_agent,created_at,last_used_at)','5', (select count(*)::text from pg_proc p, unnest(p.proargnames) a where p.proname='list_push_devices' and a in ('device_id','user_name','user_agent','created_at','last_used_at'))),
 ('대표','반환 컬럼에 endpoint·p256dh·auth가 없다','0', (select count(*)::text from pg_proc p, unnest(p.proargnames) a where p.proname='list_push_devices' and a in ('endpoint','p256dh','auth')));

set request.jwt.claim.sub = '9d999999-9d99-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('매니저','허용(대표·매니저)','ALLOWED', pg_temp.try($q$select * from public.list_push_devices()$q$));
set request.jwt.claim.sub = '9d999999-9d99-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('직원','거부','DENIED: NOT_MANAGER', pg_temp.try($q$select * from public.list_push_devices()$q$));
set request.jwt.claim.sub = '9d999999-9d99-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('타사 대표','자기 업체 기기 1대만(기기축산 기기가 안 섞임)','1', pg_temp.val($q$select count(*)::text from public.list_push_devices()$q$));
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','거부','DENIED', pg_temp.try($q$select * from public.list_push_devices()$q$));
reset role;

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
