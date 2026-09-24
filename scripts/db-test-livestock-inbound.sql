\set ON_ERROR_STOP on
-- ========== 시드 ==========
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
  ('22222222-2222-2222-2222-222222222222', 'owner-b@test.com');

insert into public.profiles (id, role, name, phone) values
  ('11111111-1111-1111-1111-111111111111', 'wholesaler', 'A사장', '01011111111'),
  ('22222222-2222-2222-2222-222222222222', 'wholesaler', 'B사장', '01022222222')
on conflict (id) do update set role = excluded.role;

insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A축산', '1110000001', 'A사장'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'B축산', '2220000002', 'B사장');

insert into public.products (id, wholesaler_id, name, category, subcategory, origin, grade, base_price, unit, stock_quantity) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '한우 등심 1++', '소', '등심', '국내산', '1++', 68000, 'kg', 0),
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '한우 채끝 1+',  '소', '채끝', '국내산', '1+',  52000, 'kg', 0);

-- A사장으로 로그인
-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- ========== 테스트 1: 마스터에 없는 이력번호 → EXCEPTION ==========
select '--- T1: 미등록 이력번호 스캔 ---' as t;
select public.record_inbound_scan('002123456789', 8.20, 'BARCODE_SCAN') -> 'status' as status_should_be_EXCEPTION;
select reason, resolved_status from public.livestock_exception_log;
select name, stock_quantity from public.products where id = 'cccccccc-0000-0000-0000-000000000001';

-- ========== 테스트 2: 마스터 적재 후 스캔 → PENDING_MAPPING ==========
select '--- T2: 마스터 적재 후 스캔(매핑 없음) ---' as t;
select public.upsert_master_livestock(
  '002123456789', 'individual', 'mtrace_livestock',
  '{"raw":"ok"}'::jsonb, '한우', '소', '등심', '1++', '2026-09-18'::date, '○○도축장', '○○농장'
);
select public.record_inbound_scan('002123456789', 8.20, 'BARCODE_SCAN') as result;

-- ========== 테스트 3: 매핑 확정 → NORMAL + 재고 반영 + 학습 ==========
select '--- T3: 매핑 확정 ---' as t;
select public.resolve_inbound_mapping(
  (select id from public.inbound_scans where status = 'PENDING_MAPPING' limit 1),
  'cccccccc-0000-0000-0000-000000000001', true
);
select name, stock_quantity as should_be_8_20 from public.products where id = 'cccccccc-0000-0000-0000-000000000001';
select species_group, part_name, grade from public.trace_product_map;

-- ========== 테스트 4: 같은 부위 재스캔 → 학습으로 자동 NORMAL ==========
select '--- T4: 학습된 매핑으로 자동 처리 ---' as t;
select public.upsert_master_livestock('002999888777','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++','2026-09-19'::date);
select public.record_inbound_scan('002999888777', 7.50, 'CAMERA') -> 'status' as status_should_be_NORMAL;
select name, stock_quantity as should_be_15_70 from public.products where id = 'cccccccc-0000-0000-0000-000000000001';

-- ========== 테스트 5: 박스가 2개로 분리되어 있는지 (설계 결정 1번) ==========
select '--- T5: 박스 단위 확인 ---' as t;
select trace_no, weight, remaining_weight, status from public.inbound_scans where status='NORMAL' order by created_at;

-- ========== 테스트 6: 오스캔 취소 → 역분개 ==========
select '--- T6: 입고 취소(역분개) ---' as t;
select public.void_inbound_scan((select id from public.inbound_scans where trace_no='002999888777'), '중복 스캔');
select name, stock_quantity as should_be_8_20_again from public.products where id = 'cccccccc-0000-0000-0000-000000000001';
select event_type, qty_delta from public.stock_ledger order by created_at;

-- ========== 테스트 7: 이미 출고된 박스는 취소 불가 ==========
select '--- T7: 부분 출고된 박스 취소 차단 ---' as t;
reset role;
update public.inbound_scans set remaining_weight = 3.00 where trace_no = '002123456789' and status='NORMAL';
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin
  perform public.void_inbound_scan((select id from public.inbound_scans where trace_no='002123456789' and status='NORMAL'));
  raise exception 'FAIL: 출고된 박스가 취소되면 안 됨';
exception when others then
  if sqlerrm = 'PARTIALLY_SHIPPED' then raise notice 'PASS: PARTIALLY_SHIPPED 로 차단됨';
  else raise exception 'FAIL: 예상과 다른 오류 %', sqlerrm; end if;
end $$;

-- ========== 테스트 8: RLS — B사장은 A사의 입고를 못 본다 ==========
select '--- T8: 테넌트 격리 ---' as t;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select count(*) as b_sees_scans_should_be_0 from public.inbound_scans;
select count(*) as b_sees_ledger_should_be_0 from public.stock_ledger;
select count(*) as b_sees_master_should_be_2 from public.master_livestock;

-- ========== 테스트 9: B사장이 A사 상품으로 스캔 시도 → 차단 ==========
select '--- T9: 남의 상품에 입고 시도 ---' as t;
do $$ begin
  perform public.record_inbound_scan('002123456789', 5.0, 'MANUAL', 'cccccccc-0000-0000-0000-000000000001');
  raise exception 'FAIL: 남의 상품에 입고가 됐음';
exception when others then
  if sqlerrm = 'PRODUCT_NOT_FOUND' then raise notice 'PASS: PRODUCT_NOT_FOUND 로 차단됨';
  else raise exception 'FAIL: 예상과 다른 오류 %', sqlerrm; end if;
end $$;
