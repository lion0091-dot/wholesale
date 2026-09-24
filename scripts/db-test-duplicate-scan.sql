\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('11111111-1111-1111-1111-111111111111','a@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values ('11111111-1111-1111-1111-111111111111','wholesaler','A','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
 values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity)
 values ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산',68000,'kg',0);

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');

select '--- D1: 첫 스캔 8.20 ---' as t;
select public.record_inbound_scan('002111111111', 8.20, 'BARCODE_SCAN', 'cccccccc-0000-0000-0000-000000000002') -> 'status';

select '--- D2: 같은 번호 + 다른 중량 8.35 → 통과해야 함 ---' as t;
select public.record_inbound_scan('002111111111', 8.35, 'BARCODE_SCAN', 'cccccccc-0000-0000-0000-000000000002') -> 'status';

select '--- D3: 같은 번호 + 같은 중량 → 경고 ---' as t;
do $$ begin
  perform public.record_inbound_scan('002111111111', 8.20, 'BARCODE_SCAN', 'cccccccc-0000-0000-0000-000000000002');
  raise exception 'FAIL: 중복이 그냥 통과됨';
exception when others then
  if sqlerrm like 'DUPLICATE_SUSPECTED:%' then raise notice 'PASS: %', sqlerrm;
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- D4: 작업자가 확인하면 통과 ---' as t;
select public.record_inbound_scan('002111111111', 8.20, 'BARCODE_SCAN', 'cccccccc-0000-0000-0000-000000000002',
  null, null, null, true) -> 'status';
select stock_quantity as should_be_24_75 from public.products where id='cccccccc-0000-0000-0000-000000000002';

select '--- D5: 엑셀은 경고 안 함 ---' as t;
select public.record_inbound_scan('002111111111', 8.20, 'EXCEL', 'cccccccc-0000-0000-0000-000000000002') -> 'status';

select '--- D6: 취소(VOIDED)된 건은 중복 판정에서 제외 ---' as t;
select public.void_inbound_scan((select id from public.inbound_scans where weight=8.35 limit 1), '테스트');
select public.record_inbound_scan('002111111111', 8.35, 'BARCODE_SCAN', 'cccccccc-0000-0000-0000-000000000002') -> 'status' as should_be_normal;
