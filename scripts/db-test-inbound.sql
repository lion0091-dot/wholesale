-- 3. 입고 통합테스트 — DB 레벨(스캔 상태 판정, 중복, 실중량 ±2%, 취소, 직접 쓰기 차단, 엑셀 대량 입고)
--    출고·주문 확정 차감은 db-test-order-stock-regression 이 다룬다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-inbound.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
    execute p_sql;
    return 'ALLOWED';
exception when others then
    return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text;
begin
    execute p_sql into v;
    return coalesce(v, '<null>');
exception when others then
    return 'ERROR: ' || split_part(sqlerrm, ':', 1);
end $$;

create function pg_temp.rows(p_sql text) returns text language plpgsql as $$
declare v bigint;
begin
    execute 'with u as (' || p_sql || ' returning 1) select count(*) from u' into v;
    return v::text;
exception when others then
    return 'ERROR: ' || split_part(sqlerrm, ':', 1);
end $$;

-- RPC 호출 결과(jsonb)를 키로 보관하고 status만 돌려주는 도우미 — 뒤에서 scan_id·중량 오차 등을 꺼내 쓴다
create temp table ids (key text primary key, id uuid, payload jsonb);
grant all on ids to authenticated, anon, service_role;

create function pg_temp.scan(p_key text, p_sql text) returns text language plpgsql as $$
declare j jsonb;
begin
    execute p_sql into j;
    insert into ids values (p_key, nullif(j->>'scan_id','')::uuid, j);
    return coalesce(j->>'status', j::text);
exception when others then
    return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- ========== 시드 (접두어 94) ==========
insert into auth.users (id,email) values
 ('94999999-0000-0000-0000-000000000001','owner-a@inb.test'),
 ('94999999-0000-0000-0000-000000000002','staff-a@inb.test'),
 ('94999999-0000-0000-0000-000000000003','manager-a@inb.test'),
 ('94999999-0000-0000-0000-000000000004','retailer-r@inb.test'),
 ('94999999-0000-0000-0000-000000000005','owner-b@inb.test'),
 ('94999999-0000-0000-0000-000000000006','super@inb.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('94999999-0000-0000-0000-000000000001','wholesaler','A사장','010',true,true),
 ('94999999-0000-0000-0000-000000000002','wholesaler','A직원','010',true,true),
 ('94999999-0000-0000-0000-000000000003','wholesaler','A매니저','010',true,true),
 ('94999999-0000-0000-0000-000000000004','retailer','식당R','010',false,false),
 ('94999999-0000-0000-0000-000000000005','wholesaler','B사장','010',true,true),
 ('94999999-0000-0000-0000-000000000006','super_admin','관리자','010',false,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a4999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000001','A축산','9490000001','A','active'),
 ('a4999999-0000-0000-0000-000000000002','94999999-0000-0000-0000-000000000005','B축산','9490000002','B','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('04999999-0000-0000-0000-000000000001','a4999999-0000-0000-0000-000000000001','A축산','9490000001'),
 ('04999999-0000-0000-0000-000000000002','a4999999-0000-0000-0000-000000000002','B축산','9490000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('04999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000001','owner'),
 ('04999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000002','staff'),
 ('04999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000003','manager'),
 ('04999999-0000-0000-0000-000000000002','94999999-0000-0000-0000-000000000005','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d4999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000004','식당R','사장','서울');
-- PA1 한우 등심(스캔 대상) / PA2 돼지 목살(명세서 부위 폴백·문서 조회) / PA3 돼지 삼겹(두 상품 걸침) / PA4 보관 상품 / PB1 B사 상품
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active,archived_at) values
 ('c4999999-0000-0000-0000-000000000001','a4999999-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0,true,null),
 ('c4999999-0000-0000-0000-000000000002','a4999999-0000-0000-0000-000000000001','돼지 목살','돼지','목살','국내산',null,15000,'kg',0,true,null),
 ('c4999999-0000-0000-0000-000000000003','a4999999-0000-0000-0000-000000000001','돼지 삼겹','돼지','삼겹살','국내산',null,20000,'kg',0,true,null),
 ('c4999999-0000-0000-0000-000000000004','a4999999-0000-0000-0000-000000000001','보관된 갈비','소','갈비','국내산',null,50000,'kg',0,false,now()),
 ('c4999999-0000-0000-0000-000000000005','a4999999-0000-0000-0000-000000000002','B사 삼겹','돼지','삼겹살','국내산',null,20000,'kg',0,true,null);

-- 공용 이력 캐시(service_role 전용) — 시드는 postgres로 넣는다. 정부 조회를 흉내 낸 것.
select public.upsert_master_livestock('009400000001','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-5,'○○도축장');
select public.upsert_master_livestock('009400000002','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-5,'○○도축장');
select public.upsert_master_livestock('009400000003','individual','mtrace_livestock','{}'::jsonb,'한우','소','채끝','1+',current_date-4,'○○도축장');
select public.upsert_master_livestock('009400000006','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('009400000007','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('009400000008','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('009400000009','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-2,'○○도축장');
select public.upsert_master_livestock('009400000010','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-2,'○○도축장');
select public.upsert_master_livestock('009400000011','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-2,'○○도축장');
select public.upsert_master_livestock('009400000012','individual','mtrace_livestock','{}'::jsonb,'한우','소','채끝','1+',current_date-1,'○○도축장');
select public.upsert_master_livestock('009400000013','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-1,'○○도축장');
select public.upsert_master_livestock('009400000014','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-1,'○○도축장');
-- 로트(묶음) — 정부 로트 응답에는 부위·등급이 없다(실데이터 확인, 2026-09-24)
select public.upsert_master_livestock('L94000000000001','group','mtrace_livestock','{}'::jsonb,'돼지','돼지',null,null,current_date-1,'△△도축장');
-- 축종조차 없는 이상 응답(자동생성 불가 판정용)
insert into public.master_livestock (trace_no,trace_kind,source,raw_payload) values ('009400000005','individual','mtrace_livestock','{}'::jsonb);

set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000001';

-- ========== 3-A. 스캔 기본 흐름 ==========
insert into results (who,what,expected,result) values
 ('A사장','이력 있음+상품 지정 8.000kg → NORMAL','NORMAL', pg_temp.scan('S1', $q$select public.record_inbound_scan('009400000001', 8.000, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','  └ 재고 8.000·원장 INBOUND 1건·잔량=중량','8.000|1|8.000', pg_temp.val($q$select p.stock_quantity::text||'|'||(select count(*) from public.stock_ledger where inbound_scan_id=(select id from ids where key='S1') and event_type='INBOUND')||'|'||s.remaining_weight::text from public.products p, public.inbound_scans s where p.id='c4999999-0000-0000-0000-000000000001' and s.id=(select id from ids where key='S1')$q$)),
 ('A사장','이력 없음(가짜 번호) → EXCEPTION, 재고 안 잡힘','EXCEPTION', pg_temp.scan('S2', $q$select public.record_inbound_scan('009400009999', 5.000, 'BARCODE_SCAN')$q$)),
 ('A사장','  └ master_found=false·잔량 0·예외로그 NOT_FOUND(사유 비움)·재고 그대로','false|0|NOT_FOUND|<null>|8.000', pg_temp.val($q$select (i.payload->>'master_found')||'|'||s.remaining_weight::int||'|'||e.reason||'|'||coalesce(e.detail,'<null>')||'|'||(select stock_quantity::text from public.products where id='c4999999-0000-0000-0000-000000000001') from ids i join public.inbound_scans s on s.id=i.id join public.livestock_exception_log e on e.inbound_scan_id=s.id where i.key='S2'$q$)),
 ('A사장','인증키 미설정 폴백(서버가 API_ERROR+사유 전달) → EXCEPTION으로 남기고 입고는 막지 않음','EXCEPTION', pg_temp.scan('S3', $q$select public.record_inbound_scan('009400009998', 5.000, 'BARCODE_SCAN', null, 'API_ERROR', null, null, false, null, null, null, null, '이력 조회 인증키가 설정되지 않았습니다.')$q$)),
 ('A사장','  └ 예외로그 API_ERROR + 사유 저장','API_ERROR|이력 조회 인증키가 설정되지 않았습니다.', pg_temp.val($q$select e.reason||'|'||e.detail from ids i join public.livestock_exception_log e on e.inbound_scan_id=i.id where i.key='S3'$q$)),
 ('A사장','예외 건(S2)에 상품 지정 → NORMAL 전환','NORMAL', pg_temp.val($q$select public.resolve_inbound_mapping((select id from ids where key='S2'), 'c4999999-0000-0000-0000-000000000001', false)->>'status'$q$)),
 ('A사장','  └ 재고 13.000·예외로그 RESOLVED','13.000|RESOLVED', pg_temp.val($q$select (select stock_quantity::text from public.products where id='c4999999-0000-0000-0000-000000000001')||'|'||e.resolved_status from ids i join public.livestock_exception_log e on e.inbound_scan_id=i.id where i.key='S2'$q$)),
 ('A사장','이미 확정된 건에 다시 상품 지정 → 거부','DENIED: SCAN_ALREADY_RESOLVED', pg_temp.try($q$select public.resolve_inbound_mapping((select id from ids where key='S2'), 'c4999999-0000-0000-0000-000000000001', false)$q$)),
 ('A사장','이력 있음(채끝 1+)+상품 미지정+매핑 없음 → PENDING_MAPPING','PENDING_MAPPING', pg_temp.scan('S5', $q$select public.record_inbound_scan('009400000003', 6.000, 'BARCODE_SCAN')$q$)),
 ('A사장','  └ 예외로그 UNMAPPED_PRODUCT·잔량 0','UNMAPPED_PRODUCT|0', pg_temp.val($q$select e.reason||'|'||s.remaining_weight::int from ids i join public.inbound_scans s on s.id=i.id join public.livestock_exception_log e on e.inbound_scan_id=s.id where i.key='S5'$q$)),
 ('A사장','  └ 자동생성 → 새 상품 "냉장 한우 채끝 1+"(소는 상품명 = 냉장/냉동 품종 부위 등급 — 113·160·178, 냉장/냉동은 사람이 입력), 가격 필요, 판매중지 상태','true|냉장 한우 채끝 1+|true|true', pg_temp.val($q$select (r->>'created')||'|'||(r->>'product_name')||'|'||(r->>'needs_price')||'|'||(r->>'needs_activation') from public.autocreate_product_for_scan((select id from ids where key='S5'), NULL, '냉장') r$q$)),
 ('A사장','  └ 새 상품 재고 6.000·스캔 NORMAL·예외 RESOLVED','6.000|NORMAL|RESOLVED', pg_temp.val($q$select p.stock_quantity::text||'|'||s.status||'|'||e.resolved_status from ids i join public.inbound_scans s on s.id=i.id join public.products p on p.id=s.product_id join public.livestock_exception_log e on e.inbound_scan_id=s.id where i.key='S5'$q$)),
 ('A사장','  └ 매핑 학습됨(소/채끝/1+) → 다음 채끝 스캔은 바로 NORMAL','NORMAL', pg_temp.scan('S5b', $q$select public.record_inbound_scan('009400000012', 4.000, 'BARCODE_SCAN')$q$)),
 ('A사장','  └ 같은 상품에 붙음','true', pg_temp.val($q$select ((select product_id from public.inbound_scans where id=(select id from ids where key='S5b')) = (select product_id from public.inbound_scans where id=(select id from ids where key='S5')))::text$q$)),
 ('A사장','자동생성을 확정된 건에 또 호출 → 거부','DENIED: SCAN_ALREADY_RESOLVED', pg_temp.try($q$select public.autocreate_product_for_scan((select id from ids where key='S5'))$q$)),
 ('A사장','로트(부위 없음)+이력조회에도 부위 없음 → PENDING_MAPPING','PENDING_MAPPING', pg_temp.scan('S6', $q$select public.record_inbound_scan('l94000000000001', 10.000, 'MANUAL')$q$)),
 ('A사장','  └ 소문자 로트번호가 대문자로 정규화됨','L94000000000001', pg_temp.val($q$select payload->>'trace_no' from ids where key='S6'$q$)),
 ('A사장','  └ 부위를 못 채워 새 상품을 "(부위 미지정)"으로 만든다(명세서 보조 경로 제거됨)','true|true', pg_temp.val($q$select (r->>'created')||'|'||(r->>'part_missing') from public.autocreate_product_for_scan((select id from ids where key='S6'), NULL, '냉장') r$q$)),
 ('A사장','  └ 새 상품 재고 10.000','10.000', pg_temp.val($q$select p.stock_quantity::text from ids i join public.inbound_scans s on s.id=i.id join public.products p on p.id=s.product_id where i.key='S6'$q$)),
 ('A사장','축종조차 없는 이력 → PENDING_MAPPING','PENDING_MAPPING', pg_temp.scan('S8', $q$select public.record_inbound_scan('009400000005', 3.000, 'MANUAL')$q$)),
 ('A사장','  └ 자동생성 불가 판정(축종 없음), 스캔은 PENDING_MAPPING 유지','INSUFFICIENT_TRACE_INFO|PENDING_MAPPING', pg_temp.val($q$select (select public.autocreate_product_for_scan(i.id)->>'reason' from ids i where i.key='S8')||'|'||(select s.status from ids i join public.inbound_scans s on s.id=i.id where i.key='S8')$q$)),
 ('A사장','중량 0 → 거부','DENIED: INVALID_WEIGHT', pg_temp.try($q$select public.record_inbound_scan('009400000006', 0, 'MANUAL')$q$)),
 ('A사장','중량 음수 → 거부','DENIED: INVALID_WEIGHT', pg_temp.try($q$select public.record_inbound_scan('009400000006', -1, 'MANUAL')$q$)),
 ('A사장','빈 이력번호 → 거부','DENIED: EMPTY_TRACE_NO', pg_temp.try($q$select public.record_inbound_scan('   ', 1, 'MANUAL')$q$)),
 ('A사장','B사 상품 ID로 입고 → 거부','DENIED: PRODUCT_NOT_FOUND', pg_temp.try($q$select public.record_inbound_scan('009400000006', 1, 'MANUAL', 'c4999999-0000-0000-0000-000000000005')$q$)),
 ('A사장','허용되지 않는 스캔 종류 → 거부(CHECK)','DENIED', pg_temp.try($q$select public.record_inbound_scan('009400000006', 1, 'DRONE')$q$));

-- ========== 3-B. 중복 스캔 (같은 번호·같은 중량·10분 안) ==========
insert into results (who,what,expected,result) values
 ('A사장','첫 스캔 8.000 → NORMAL','NORMAL', pg_temp.scan('D1', $q$select public.record_inbound_scan('009400000002', 8.000, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','같은 번호·같은 중량 다시 → DUPLICATE_SUSPECTED(직전 시각 포함)','DENIED: DUPLICATE_SUSPECTED', pg_temp.try($q$select public.record_inbound_scan('009400000002', 8.000, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','  └ 사용자가 중복 확인 후 강행 → 허용','NORMAL', pg_temp.scan('D2', $q$select public.record_inbound_scan('009400000002', 8.000, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001', null, null, null, true)$q$)),
 ('A사장','같은 번호·다른 중량(8.100) → 통과','NORMAL', pg_temp.scan('D3', $q$select public.record_inbound_scan('009400000002', 8.100, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','EXCEL 경로는 중복 검사 생략(행마다 물어볼 수 없음)','NORMAL', pg_temp.scan('D4', $q$select public.record_inbound_scan('009400000002', 8.000, 'EXCEL', 'c4999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','8.100 건 취소 → VOIDED','VOIDED', pg_temp.val($q$select public.void_inbound_scan((select id from ids where key='D3'), '잘못 찍음')->>'status'$q$)),
 ('A사장','  └ 8.100 다시 → 취소된 박스는 중복 대상 아님','NORMAL', pg_temp.scan('D5', $q$select public.record_inbound_scan('009400000002', 8.100, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001')$q$));

-- ========== 3-C. 실중량 검수 ±2% + 매입금액 ==========
insert into results (who,what,expected,result) values
 ('A사장','표기 20.000 / 실측 19.600 = 정확히 -2% → 허용 범위(경계)','false|-0.400|-0.0200', pg_temp.val($q$select pg_temp.scan('W1', $$select public.record_inbound_scan('009400000006', 19.600, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001', null, null, null, false, null, 20.000)$$), null; select (payload->>'variance_exceeded')||'|'||(payload->>'weight_variance')||'|'||(payload->>'variance_ratio') from ids where key='W1'$q$)),
 ('A사장','  └ 재고는 실중량 기준(원장 +19.600)','19.600', pg_temp.val($q$select qty_delta::text from public.stock_ledger where inbound_scan_id=(select id from ids where key='W1')$q$)),
 ('A사장','표기 20.000 / 실측 19.590 = -2.05% → 초과 경고','true', pg_temp.val($q$select pg_temp.scan('W2', $$select public.record_inbound_scan('009400000007', 19.590, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001', null, null, null, false, null, 20.000)$$), null; select payload->>'variance_exceeded' from ids where key='W2'$q$)),
 ('A사장','표기 10.000 / 실측 10.200 = +2% → 허용(양방향 같은 기준)','false', pg_temp.val($q$select pg_temp.scan('W2b', $$select public.record_inbound_scan('009400000013', 10.200, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001', null, null, null, false, null, 10.000)$$), null; select payload->>'variance_exceeded' from ids where key='W2b'$q$)),
 ('A사장','표기중량 없음 → 오차 판정 안 함','false|<null>', pg_temp.val($q$select pg_temp.scan('W3', $$select public.record_inbound_scan('009400000008', 7.000, 'MANUAL', 'c4999999-0000-0000-0000-000000000001')$$), null; select (payload->>'variance_exceeded')||'|'||coalesce(payload->>'weight_variance','<null>') from ids where key='W3'$q$)),
 ('A사장','표기중량 0 → 거부(CHECK)','DENIED', pg_temp.try($q$select public.record_inbound_scan('009400000008', 7.100, 'MANUAL', 'c4999999-0000-0000-0000-000000000001', null, null, null, false, null, 0)$q$)),
 ('A사장','상품 기본 매입단가 50,000 등록','ALLOWED', pg_temp.try($q$select public.set_product_purchase_price('c4999999-0000-0000-0000-000000000001', 50000, '○○도축장')$q$)),
 ('A사장','단가 안 적고 실측 10.000(표기 10.500) → 매입금액 = 실중량×기본단가 = 500,000','500000.00|○○도축장', pg_temp.val($q$select pg_temp.scan('W4', $$select public.record_inbound_scan('009400000009', 10.000, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001', null, null, null, false, null, 10.500)$$), null; select (payload->>'purchase_amount')||'|'||(payload->>'purchase_supplier') from ids where key='W4'$q$)),
 ('A사장','건별 단가 55,000이 기본단가를 이김 → 550,000','550000.00|△△산업', pg_temp.val($q$select pg_temp.scan('W5', $$select public.record_inbound_scan('009400000010', 10.000, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001', null, null, null, false, null, 10.000, 55000, '△△산업')$$), null; select (payload->>'purchase_amount')||'|'||(payload->>'purchase_supplier') from ids where key='W5'$q$)),
 ('A사장','매입금액은 GENERATED — 직접 고치기 → 거부','DENIED', pg_temp.try($q$update public.inbound_scans set purchase_amount = 1 where id=(select id from ids where key='W5')$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A직원','직원이 단가 적어 입고 → 거부(원가는 관리자만, 098)','DENIED: FORBIDDEN_PURCHASE_PRICE', pg_temp.try($q$select public.record_inbound_scan('009400000011', 5.000, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001', null, null, null, false, null, null, 40000)$q$)),
 ('A직원','직원이 단가 없이 입고 → 허용, 기본단가가 따라 붙음','NORMAL|50000.00|250000.00', pg_temp.val($q$select pg_temp.scan('W6', $$select public.record_inbound_scan('009400000011', 5.000, 'BARCODE_SCAN', 'c4999999-0000-0000-0000-000000000001')$$), null; select (payload->>'status')||'|'||(payload->>'purchase_unit_price')||'|'||(payload->>'purchase_amount') from ids where key='W6'$q$)),
 ('A직원','직원이 매입단가 수정 → 거부','DENIED', pg_temp.try($q$select public.update_inbound_purchase((select id from ids where key='W6'), 30000, null, false, null)$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000001';

-- ========== 3-D. 입고 취소 ==========
insert into results (who,what,expected,result) values
 ('A사장','NORMAL 박스(W3, 7.000) 취소 → VOIDED','VOIDED', pg_temp.val($q$select public.void_inbound_scan((select id from ids where key='W3'), '오입고')->>'status'$q$)),
 ('A사장','  └ 원장 INBOUND_VOID -7.000, 그 박스 원장 합 0, 잔량 0','-7.000|0.000|0', pg_temp.val($q$select (select qty_delta::text from public.stock_ledger where inbound_scan_id=i.id and event_type='INBOUND_VOID')||'|'||(select sum(qty_delta)::text from public.stock_ledger where inbound_scan_id=i.id)||'|'||s.remaining_weight::int from ids i join public.inbound_scans s on s.id=i.id where i.key='W3'$q$)),
 ('A사장','  └ 표시 재고 = 원장 합계','true', pg_temp.val($q$select (p.stock_quantity = (select sum(qty_delta) from public.stock_ledger where product_id=p.id))::text from public.products p where id='c4999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','같은 박스 두 번 취소 → 거부','DENIED: ALREADY_VOIDED', pg_temp.try($q$select public.void_inbound_scan((select id from ids where key='W3'), '또')$q$)),
 ('A사장','예외 건(S3) 취소 → VOIDED','VOIDED', pg_temp.val($q$select public.void_inbound_scan((select id from ids where key='S3'), '가짜')->>'status'$q$)),
 ('A사장','  └ 예외로그 DISCARDED','DISCARDED', pg_temp.val($q$select resolved_status from public.livestock_exception_log where inbound_scan_id=(select id from ids where key='S3')$q$)),
 ('A사장','취소된 건에 상품 지정 → 거부','DENIED: SCAN_ALREADY_RESOLVED', pg_temp.try($q$select public.resolve_inbound_mapping((select id from ids where key='S3'), 'c4999999-0000-0000-0000-000000000001', false)$q$));

-- ========== 3-E. 직접 쓰기·타사·계정 종류 ==========
insert into results (who,what,expected,result) values
 ('A사장','inbound_scans 직접 INSERT(재고 위조) → 거부','DENIED', pg_temp.try($q$insert into public.inbound_scans (wholesaler_id,trace_no,product_id,weight,scan_type,status,remaining_weight) values ('a4999999-0000-0000-0000-000000000001','009400000014','c4999999-0000-0000-0000-000000000001',100,'MANUAL','NORMAL',100)$q$)),
 ('A사장','inbound_scans 잔량 직접 UPDATE → 0행','0', pg_temp.rows($q$update public.inbound_scans set remaining_weight = 999 where id=(select id from ids where key='S1')$q$)),
 ('A사장','inbound_scans 직접 DELETE → 0행','0', pg_temp.rows($q$delete from public.inbound_scans where id=(select id from ids where key='S1')$q$)),
 ('A사장','stock_ledger 직접 INSERT → 거부','DENIED', pg_temp.try($q$insert into public.stock_ledger (wholesaler_id,product_id,qty_delta,event_type,source_type,source_id) values ('a4999999-0000-0000-0000-000000000001','c4999999-0000-0000-0000-000000000001',100,'INBOUND','manual',gen_random_uuid())$q$)),
 ('A사장','예외로그 직접 INSERT/삭제 → 거부/0행','DENIED|0', left(pg_temp.try($q$insert into public.livestock_exception_log (wholesaler_id,raw_input,reason) values ('a4999999-0000-0000-0000-000000000001','x','NOT_FOUND')$q$),6)||'|'||pg_temp.rows($q$delete from public.livestock_exception_log where wholesaler_id='a4999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','공용 이력 캐시 직접 쓰기 → 거부(098)','DENIED', pg_temp.try($q$select public.upsert_master_livestock('009400000099','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date,'x')$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('B사장','A사 스캔·원장·예외로그 조회 → 0건','0|0|0', pg_temp.val($q$select (select count(*) from public.inbound_scans where wholesaler_id='a4999999-0000-0000-0000-000000000001')||'|'||(select count(*) from public.stock_ledger where wholesaler_id='a4999999-0000-0000-0000-000000000001')||'|'||(select count(*) from public.livestock_exception_log where wholesaler_id='a4999999-0000-0000-0000-000000000001')$q$)),
 ('B사장','A사 박스 취소 → 거부','DENIED: SCAN_NOT_FOUND', pg_temp.try($q$select public.void_inbound_scan((select id from ids where key='S1'), 'x')$q$)),
 ('B사장','A사 박스에 상품 지정 → 거부','DENIED: SCAN_NOT_FOUND', pg_temp.try($q$select public.resolve_inbound_mapping((select id from ids where key='S8'), 'c4999999-0000-0000-0000-000000000005', false)$q$)),
 ('B사장','A사 박스 자동생성 → 거부','DENIED: SCAN_NOT_FOUND', pg_temp.try($q$select public.autocreate_product_for_scan((select id from ids where key='S8'))$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','고객 계정 입고 스캔 → 거부','DENIED: NOT_A_SUPPLIER', pg_temp.try($q$select public.record_inbound_scan('009400000014', 1, 'MANUAL')$q$)),
 ('식당R','고객 계정 취소·상품지정 → 거부','DENIED: NOT_A_SUPPLIER|DENIED: NOT_A_SUPPLIER', pg_temp.try($q$select public.void_inbound_scan((select id from ids where key='S1'), 'x')$q$)||'|'||pg_temp.try($q$select public.resolve_inbound_mapping((select id from ids where key='S8'), 'c4999999-0000-0000-0000-000000000001', false)$q$)),
 ('식당R','공용 이력 캐시 읽기는 허용(공개 데이터)','true', pg_temp.val($q$select (count(*) > 0)::text from public.master_livestock where trace_no='009400000001'$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A직원','직원은 자기 회사 스캔·예외로그 조회 가능','true|true', pg_temp.val($q$select (count(*) > 0)::text||'|'||((select count(*) from public.livestock_exception_log where wholesaler_id='a4999999-0000-0000-0000-000000000001') > 0)::text from public.inbound_scans where wholesaler_id='a4999999-0000-0000-0000-000000000001'$q$)),
 ('A직원','직원이 박스 취소 → 허용(현장 작업)','VOIDED', pg_temp.val($q$select public.void_inbound_scan((select id from ids where key='D5'), '직원 취소')->>'status'$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000001';

-- ========== 3-G. 엑셀 대량 입고 ==========
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A직원','업로드 작업+행 2개 생성 → 허용','ALLOWED', pg_temp.try($q$insert into public.inbound_import_jobs (id,wholesaler_id,file_name,total_rows,status,created_by) values ('a5999999-0000-0000-0000-000000000001','a4999999-0000-0000-0000-000000000001','입고.xlsx',2,'PENDING','94999999-0000-0000-0000-000000000002'); insert into public.inbound_import_rows (id,job_id,row_no,trace_no,weight) values ('b5999999-0000-0000-0000-000000000001','a5999999-0000-0000-0000-000000000001',1,'009400000014',5.000),('b5999999-0000-0000-0000-000000000002','a5999999-0000-0000-0000-000000000001',2,'009400000014',3.000)$q$)),
 ('A직원','중량 0 / 음수 행 저장 → 거부(106 CHECK)','DENIED|DENIED', left(pg_temp.try($q$insert into public.inbound_import_rows (job_id,row_no,trace_no,weight) values ('a5999999-0000-0000-0000-000000000001',3,'009400000014',0)$q$),6)||'|'||left(pg_temp.try($q$insert into public.inbound_import_rows (job_id,row_no,trace_no,weight) values ('a5999999-0000-0000-0000-000000000001',4,'009400000014',-1)$q$),6)),
 ('A직원','1행 입고(EXCEL, 행 ID 붙임) → NORMAL','NORMAL', pg_temp.scan('X1', $q$select public.record_inbound_scan('009400000014', 5.000, 'EXCEL', 'c4999999-0000-0000-0000-000000000001', null, 'b5999999-0000-0000-0000-000000000001', null, true)$q$)),
 ('A직원','같은 1행을 다른 창이 또 입고 → 유니크 거부(097, 재고 두 배 방지)','DENIED', pg_temp.try($q$select public.record_inbound_scan('009400000014', 5.000, 'EXCEL', 'c4999999-0000-0000-0000-000000000001', null, 'b5999999-0000-0000-0000-000000000001', null, true)$q$)),
 ('A직원','  └ 그 행의 스캔은 1건뿐','1', pg_temp.val($q$select count(*)::text from public.inbound_scans where import_row_id='b5999999-0000-0000-0000-000000000001'$q$)),
 ('A직원','2행을 중량 0으로 입고 호출 → INVALID_WEIGHT(RPC 자체 검사, 앱이 FAILED로 기록)','DENIED: INVALID_WEIGHT', pg_temp.try($q$select public.record_inbound_scan('009400000014', 0, 'EXCEL', 'c4999999-0000-0000-0000-000000000001', null, 'b5999999-0000-0000-0000-000000000002', null, true)$q$)),
 ('A직원','행 상태 기록 DONE/FAILED (PENDING 가드) → 1행/1행, 다시 덮어쓰기 0행','1|1|0', pg_temp.rows($q$update public.inbound_import_rows set status='DONE', scan_id=(select id from ids where key='X1') where id='b5999999-0000-0000-0000-000000000001' and status='PENDING'$q$)||'|'||pg_temp.rows($q$update public.inbound_import_rows set status='FAILED', error_detail='중량을 입력해주세요.' where id='b5999999-0000-0000-0000-000000000002' and status='PENDING'$q$)||'|'||pg_temp.rows($q$update public.inbound_import_rows set status='FAILED' where id='b5999999-0000-0000-0000-000000000001' and status='PENDING'$q$)),
 ('A직원','행 상태에 정해진 값 밖 → 거부(CHECK)','DENIED', pg_temp.try($q$update public.inbound_import_rows set status='SKIPPED' where id='b5999999-0000-0000-0000-000000000002'$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('B사장','A사 업로드 작업 조회 → 0건, A사 작업에 행 끼워넣기 → 거부','0|DENIED', pg_temp.val($q$select count(*)::text from public.inbound_import_jobs where id='a5999999-0000-0000-0000-000000000001'$q$)||'|'||left(pg_temp.try($q$insert into public.inbound_import_rows (job_id,row_no,trace_no,weight) values ('a5999999-0000-0000-0000-000000000001',3,'009400000014',1)$q$),6)),
 ('B사장','A사 행 상태 조작 → 0행','0', pg_temp.rows($q$update public.inbound_import_rows set status='DONE' where id='b5999999-0000-0000-0000-000000000002'$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','고객 계정이 업로드 작업 생성 → 거부','DENIED', pg_temp.try($q$insert into public.inbound_import_jobs (wholesaler_id,file_name,total_rows,status,created_by) values ('a4999999-0000-0000-0000-000000000001','x.xlsx',1,'PENDING','94999999-0000-0000-0000-000000000004')$q$));

reset role;
select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
