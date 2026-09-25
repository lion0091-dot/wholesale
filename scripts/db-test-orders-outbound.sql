-- 4. 출고·주문 통합테스트 — DB 레벨(주문 생성 게이트, 상태 전이, 바이어 취소, 확정·취소 재고, 출고 스캔, 출고 확정, 격리)
--    동시 확정 경쟁은 db-test-order-stock-concurrency.sh 가 다룬다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-orders-outbound.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
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

-- RPC jsonb 결과를 키로 보관 — 뒤에서 taken/days_left 등을 꺼내 쓴다
create temp table ids (key text primary key, payload jsonb);
grant all on ids to authenticated, anon, service_role;

create function pg_temp.rpc(p_key text, p_sql text) returns text language plpgsql as $$
declare j jsonb;
begin
    execute p_sql into j;
    insert into ids values (p_key, j) on conflict (key) do update set payload = excluded.payload;
    return 'ALLOWED';
exception when others then
    return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- ========== 시드 (접두어 95) ==========
insert into auth.users (id,email) values
 ('95999999-0000-0000-0000-000000000001','owner-a@ord.test'),
 ('95999999-0000-0000-0000-000000000002','staff-a@ord.test'),
 ('95999999-0000-0000-0000-000000000003','retailer-r@ord.test'),
 ('95999999-0000-0000-0000-000000000004','owner-b@ord.test'),
 ('95999999-0000-0000-0000-000000000005','retailer-x@ord.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('95999999-0000-0000-0000-000000000001','wholesaler','A사장','010',true,true),
 ('95999999-0000-0000-0000-000000000002','wholesaler','A직원','010',true,true),
 ('95999999-0000-0000-0000-000000000003','retailer','식당R','010',false,false),
 ('95999999-0000-0000-0000-000000000004','wholesaler','B사장','010',true,true),
 ('95999999-0000-0000-0000-000000000005','retailer','식당X','010',false,false)
 on conflict (id) do update set role=excluded.role, name=excluded.name;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a5999999-0000-0000-0000-000000000001','95999999-0000-0000-0000-000000000001','A축산','9590000001','A','active'),
 ('a5999999-0000-0000-0000-000000000002','95999999-0000-0000-0000-000000000004','B축산','9590000002','B','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('05999999-0000-0000-0000-000000000001','a5999999-0000-0000-0000-000000000001','A축산','9590000001'),
 ('05999999-0000-0000-0000-000000000002','a5999999-0000-0000-0000-000000000002','B축산','9590000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('05999999-0000-0000-0000-000000000001','95999999-0000-0000-0000-000000000001','owner'),
 ('05999999-0000-0000-0000-000000000001','95999999-0000-0000-0000-000000000002','staff'),
 ('05999999-0000-0000-0000-000000000002','95999999-0000-0000-0000-000000000004','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d5999999-0000-0000-0000-000000000001','95999999-0000-0000-0000-000000000003','식당R','사장','서울'),
 ('d5999999-0000-0000-0000-000000000002','95999999-0000-0000-0000-000000000005','식당X','사장','부산');
-- R은 거래중(미수금 50,000 시드), X는 거래중지
insert into public.wholesaler_retailers (id,wholesaler_id,retailer_id,status,outstanding_balance,credit_limit,allowed_payment_methods) values
 ('b5999999-0000-0000-0000-000000000001','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','active',50000,1000000,array['prepaid','on_credit']),
 ('b5999999-0000-0000-0000-000000000002','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000002','blocked',0,0,array['prepaid']);
-- P1 등심(박스 재고) / P2 삼겹(재고 0, 정지 안 됨) / P3 목살(박스 없는 수동 재고 5) / P4 발주정지 / P5 핫딜(한도 10) / PB B사
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active,order_stopped,order_stopped_reason,hot_deal_active,hot_deal_price,hot_deal_quantity_limit,hot_deal_quantity_sold) values
 ('c5999999-0000-0000-0000-000000000001','a5999999-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0,true,false,null,false,null,null,0),
 ('c5999999-0000-0000-0000-000000000002','a5999999-0000-0000-0000-000000000001','돼지 삼겹','돼지','삼겹살','국내산',null,20000,'kg',0,true,false,null,false,null,null,0),
 ('c5999999-0000-0000-0000-000000000003','a5999999-0000-0000-0000-000000000001','돼지 목살','돼지','목살','국내산',null,15000,'kg',5,true,false,null,false,null,null,0),
 ('c5999999-0000-0000-0000-000000000004','a5999999-0000-0000-0000-000000000001','정지 상품','돼지','갈비','국내산',null,30000,'kg',10,true,true,'manual',false,null,null,0),
 ('c5999999-0000-0000-0000-000000000005','a5999999-0000-0000-0000-000000000001','핫딜 앞다리','돼지','앞다리','국내산',null,12000,'kg',20,true,false,null,true,10000,10,0),
 ('c5999999-0000-0000-0000-000000000006','a5999999-0000-0000-0000-000000000002','B사 삼겹','돼지','삼겹살','국내산',null,20000,'kg',10,true,false,null,false,null,null,0);
-- 이력 캐시(postgres 시드)
select public.upsert_master_livestock('009500000001','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-9,'○○도축장');
select public.upsert_master_livestock('009500000002','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-8,'○○도축장');
select public.upsert_master_livestock('009500000003','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-40,'○○도축장');
select public.upsert_master_livestock('009500000004','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-7,'○○도축장');
select public.upsert_master_livestock('009500000005','individual','mtrace_livestock','{}'::jsonb,'돼지','돼지','삼겹살',null,current_date-2,'△△도축장');
-- 주문 시드(상태별). 바이어가 직접 만드는 주문은 4-A에서 세션으로 넣는다.
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method,settled_at) values
 ('e5999999-0000-0000-0000-000000000003','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-3',15000,'shipping','서울','prepaid',null),
 ('e5999999-0000-0000-0000-000000000006','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-6',1360000,'pending','서울','prepaid',null),
 ('e5999999-0000-0000-0000-000000000007','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-7',272000,'pending','서울','prepaid',null),
 ('e5999999-0000-0000-0000-000000000008','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-8',15000,'delivered','서울','prepaid',null),
 ('e5999999-0000-0000-0000-000000000009','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-9',30000,'cancel_requested','서울','prepaid',null),
 ('e5999999-0000-0000-0000-000000000010','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-10',30000,'pending','서울','on_credit',null),
 ('e5999999-0000-0000-0000-000000000011','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-11',10000,'pending','서울','on_credit',now()),
 ('e5999999-0000-0000-0000-000000000014','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-14',15000,'pending','서울','prepaid',null),
 ('e5999999-0000-0000-0000-000000000015','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-15',15000,'awaiting_stock','서울','prepaid',null),
 ('e5999999-0000-0000-0000-000000000016','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-16',68000,'pending','서울','prepaid',null),
 ('e5999999-0000-0000-0000-000000000017','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-17',15000,'pending','서울','prepaid',null);
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('e5999999-0000-0000-0000-000000000003','c5999999-0000-0000-0000-000000000003','돼지 목살',15000,1,15000),
 ('e5999999-0000-0000-0000-000000000006','c5999999-0000-0000-0000-000000000001','한우 등심',68000,20,1360000),
 ('e5999999-0000-0000-0000-000000000007','c5999999-0000-0000-0000-000000000001','한우 등심',68000,4,272000),
 ('e5999999-0000-0000-0000-000000000008','c5999999-0000-0000-0000-000000000003','돼지 목살',15000,1,15000),
 ('e5999999-0000-0000-0000-000000000009','c5999999-0000-0000-0000-000000000003','돼지 목살',15000,2,30000),
 ('e5999999-0000-0000-0000-000000000010','c5999999-0000-0000-0000-000000000003','돼지 목살',15000,2,30000),
 ('e5999999-0000-0000-0000-000000000011','c5999999-0000-0000-0000-000000000003','돼지 목살',15000,1,15000),
 ('e5999999-0000-0000-0000-000000000014','c5999999-0000-0000-0000-000000000003','돼지 목살',15000,1,15000),
 ('e5999999-0000-0000-0000-000000000015','c5999999-0000-0000-0000-000000000003','돼지 목살',15000,1,15000),
 ('e5999999-0000-0000-0000-000000000016','c5999999-0000-0000-0000-000000000001','한우 등심',68000,1,68000),
 ('e5999999-0000-0000-0000-000000000017','c5999999-0000-0000-0000-000000000003','돼지 목살',15000,1,15000);

-- P1 박스 4개 입고 (같은 트랜잭션이라 created_at 동률 → 보조 정렬 trace_no 순 = b1,b2,b3,b4)
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '95999999-0000-0000-0000-000000000001';
select public.record_inbound_scan('009500000001', 5.000, 'BARCODE_SCAN', 'c5999999-0000-0000-0000-000000000001') ->> 'status' as b1;
select public.record_inbound_scan('009500000002', 5.000, 'BARCODE_SCAN', 'c5999999-0000-0000-0000-000000000001') ->> 'status' as b2;
select public.record_inbound_scan('009500000003', 4.000, 'BARCODE_SCAN', 'c5999999-0000-0000-0000-000000000001', null, null, null, false, current_date - 1) ->> 'status' as b3_expired;
select public.record_inbound_scan('009500000004', 3.000, 'BARCODE_SCAN', 'c5999999-0000-0000-0000-000000000001', null, null, null, false, current_date + 2) ->> 'status' as b4_soon;
create temp table box as select trace_no, id from public.inbound_scans where wholesaler_id='a5999999-0000-0000-0000-000000000001';
grant all on box to authenticated, anon, service_role;

-- ========== 4-A. 주문 생성 게이트 (바이어 세션) ==========
set request.jwt.claim.sub = '95999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('식당R','거래중 공급사에 주문 헤더 → 허용','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e5999999-0000-0000-0000-000000000001','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-1',60000,'pending','서울')$q$)),
 ('식당R','발주정지 상품 품목 → 거부(103 회귀)','DENIED: PRODUCT_NOT_ORDERABLE', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e5999999-0000-0000-0000-000000000001','c5999999-0000-0000-0000-000000000004','정지',30000,1,30000)$q$)),
 ('식당R','B사 상품 품목 → 거부','DENIED: PRODUCT_NOT_FOUND', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e5999999-0000-0000-0000-000000000001','c5999999-0000-0000-0000-000000000006','B',20000,1,20000)$q$)),
 ('식당R','[정보] 재고 0인데 정지 안 된 신규 상품(P2) 품목 → DB 허용(재고 검사는 확정 시점)','ALLOWED|false', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e5999999-0000-0000-0000-000000000001','c5999999-0000-0000-0000-000000000002','삼겹',20000,2,40000)$q$)||'|'||pg_temp.val($q$select order_stopped::text from public.products where id='c5999999-0000-0000-0000-000000000002'$q$)),
 ('식당R','최소발주금액(50,000) 미달 주문 15,000 → 거부(107)','50000|DENIED: MIN_ORDER_AMOUNT', pg_temp.val($q$select min_order_amount::int::text from public.wholesalers where id='a5999999-0000-0000-0000-000000000001'$q$)||'|'||pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e5999999-0000-0000-0000-000000000002','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-2',15000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e5999999-0000-0000-0000-000000000002','c5999999-0000-0000-0000-000000000003','목살',15000,1,15000)$q$)),
 ('식당R','정상 주문 O5(등심 8kg) 생성 → 허용','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e5999999-0000-0000-0000-000000000005','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-5',544000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e5999999-0000-0000-0000-000000000005','c5999999-0000-0000-0000-000000000001','등심',68000,8,544000)$q$)),
 ('식당R','배송중 주문(O3)에 품목 추가 → 거부','DENIED: ORDER_NOT_PENDING', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e5999999-0000-0000-0000-000000000003','c5999999-0000-0000-0000-000000000003','목살',15000,1,15000)$q$)),
 ('식당R','핫딜 품목 4kg@10,000 → 허용, 판매량 4·예약 기록','ALLOWED|4', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e5999999-0000-0000-0000-000000000012','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-12',50000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount,is_hot_deal) values ('e5999999-0000-0000-0000-000000000012','c5999999-0000-0000-0000-000000000005','핫딜',10000,4,40000,true)$q$)||'|'||pg_temp.val($q$select hot_deal_quantity_sold::int::text from public.products where id='c5999999-0000-0000-0000-000000000005'$q$)),
 ('식당R','  └ 예약 테이블은 바이어가 못 읽음(내부용)','DENIED', pg_temp.try($q$select count(*) from public.hot_deal_quota_reservations$q$)),
 ('식당R','핫딜 한도 초과(남은 6, 7kg) → 거부','DENIED: HOT_DEAL_QUOTA_EXCEEDED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e5999999-0000-0000-0000-000000000013','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','ORD-13',70000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount,is_hot_deal) values ('e5999999-0000-0000-0000-000000000013','c5999999-0000-0000-0000-000000000005','핫딜',10000,7,70000,true)$q$));
set request.jwt.claim.sub = '95999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('식당X','거래중지 관계로 주문 헤더 → 거부(RLS)','DENIED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e5999999-0000-0000-0000-000000000099','a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000002','ORD-X',15000,'pending','부산')$q$));

-- ========== 4-B. 확정 → 선입선출 차감 / 재고 부족 / 기한 지난 박스 제외 (공급사 세션) ==========
set request.jwt.claim.sub = '95999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','O5(8kg) 확정 → 1행','1', pg_temp.rows($q$update public.orders set status='confirmed' where id='e5999999-0000-0000-0000-000000000005'$q$)),
 ('A사장','  └ b1 5→0, b2 5→2, ORDER_OUT 2건, 표시 재고 9.000','0.000|2.000|2|9.000', pg_temp.val($q$select (select remaining_weight::text from public.inbound_scans where trace_no='009500000001')||'|'||(select remaining_weight::text from public.inbound_scans where trace_no='009500000002')||'|'||(select count(*) from public.stock_ledger where source_id='e5999999-0000-0000-0000-000000000005' and event_type='ORDER_OUT')||'|'||(select stock_quantity::text from public.products where id='c5999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','O7(4kg) 확정 → 기한 지난 b3(4kg) 건너뛰고 b2 2 + b4 2','1|0.000|4.000|1.000|5.000', pg_temp.rows($q$update public.orders set status='confirmed' where id='e5999999-0000-0000-0000-000000000007'$q$)||'|'||pg_temp.val($q$select (select remaining_weight::text from public.inbound_scans where trace_no='009500000002')||'|'||(select remaining_weight::text from public.inbound_scans where trace_no='009500000003')||'|'||(select remaining_weight::text from public.inbound_scans where trace_no='009500000004')||'|'||(select stock_quantity::text from public.products where id='c5999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','O6(20kg, 가용 1kg) 확정 → 거부','DENIED: INSUFFICIENT_STOCK', pg_temp.try($q$update public.orders set status='confirmed' where id='e5999999-0000-0000-0000-000000000006'$q$)),
 ('A사장','O1(재고 0 상품 P2) 확정 → 거부 — 재고 0 주문은 여기서 걸린다','DENIED: INSUFFICIENT_STOCK', pg_temp.try($q$update public.orders set status='confirmed' where id='e5999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','  └ 거부된 주문은 접수대기 그대로·원장 없음','pending|0', pg_temp.val($q$select status||'|'||(select count(*) from public.stock_ledger where source_id='e5999999-0000-0000-0000-000000000006') from public.orders where id='e5999999-0000-0000-0000-000000000006'$q$));
-- P2 박스 하나(주문에 없는 상품 스캔용)
select public.record_inbound_scan('009500000005', 3.000, 'BARCODE_SCAN', 'c5999999-0000-0000-0000-000000000002') ->> 'status' as b5;

-- ========== 4-C. 출고 스캔 (O7 확정, 자동배정 b2 2 + b4 2) ==========
insert into results (who,what,expected,result) values
 ('A사장','피킹 목록: 자동배정 박스 2줄, 아직 안 찍음','2|0', pg_temp.val($q$select count(*) filter (where not already_picked)||'|'||count(*) filter (where already_picked) from public.get_picking_list('e5999999-0000-0000-0000-000000000007')$q$)),
 ('A사장','자동배정돼 잔량 0인 b2를 찍음 → 허용(099), 2kg 배정, 남은 필요 2','ALLOWED|2.000|2.000', pg_temp.rpc('X1', $q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000007', '009500000002')$q$)||'|'||pg_temp.val($q$select (payload->>'taken')||'|'||(payload->>'remaining_needed') from ids where key='X1'$q$)),
 ('A사장','기한 지난 b3 찍음 → BOX_EXPIRED','DENIED: BOX_EXPIRED', pg_temp.try($q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000007', '009500000003')$q$)),
 ('A사장','임박 박스 b4 찍음 → 허용, days_left 2, 남은 필요 0','ALLOWED|2.000|2|0.000', pg_temp.rpc('X2', $q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000007', '009500000004')$q$)||'|'||pg_temp.val($q$select (payload->>'taken')||'|'||(payload->>'days_left')||'|'||(payload->>'remaining_needed') from ids where key='X2'$q$)),
 ('A사장','다 채운 상품 박스 또 찍음 → 거부','DENIED: PRODUCT_ALREADY_FULFILLED', pg_temp.try($q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000007', '009500000004')$q$)),
 ('A사장','주문에 없는 상품(P2) 박스 찍음 → 거부','DENIED: PRODUCT_NOT_IN_ORDER', pg_temp.try($q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000007', '009500000005')$q$)),
 ('A사장','없는 이력번호 → 거부','DENIED: BOX_NOT_AVAILABLE', pg_temp.try($q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000007', '009599999999')$q$)),
 ('A사장','피킹 목록: 찍은 박스 2줄로 표시','0|2', pg_temp.val($q$select count(*) filter (where not already_picked)||'|'||count(*) filter (where already_picked) from public.get_picking_list('e5999999-0000-0000-0000-000000000007')$q$)),
 ('A사장','  └ 표시 재고는 그대로 5.000(배정 정정 +4 / 스캔 배정 -4)','5.000|true', pg_temp.val($q$select stock_quantity::text||'|'||(stock_quantity = (select sum(qty_delta) from public.stock_ledger where product_id=p.id))::text from public.products p where id='c5999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','접수대기 주문(O6) 출고 스캔 → 거부','DENIED: ORDER_NOT_SHIPPABLE', pg_temp.try($q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000006', '009500000001')$q$));

-- ========== 4-D. 출고 확정 ==========
insert into results (who,what,expected,result) values
 ('A사장','O7 출고 확정 → 부족 없음, 총액 272,000, 배송중','ALLOWED|false|272000.00|shipping', pg_temp.rpc('F1', $q$select public.finalize_order_shipment('e5999999-0000-0000-0000-000000000007')$q$)||'|'||pg_temp.val($q$select (payload->>'was_short')||'|'||(payload->>'total_amount')||'|'||(select status from public.orders where id='e5999999-0000-0000-0000-000000000007') from ids where key='F1'$q$)),
 ('A사장','확정 뒤 스캔 → 거부','DENIED: ALREADY_FINALIZED', pg_temp.try($q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000007', '009500000004')$q$)),
 ('A사장','두 번 확정 → 거부','DENIED: ALREADY_FINALIZED', pg_temp.try($q$select public.finalize_order_shipment('e5999999-0000-0000-0000-000000000007')$q$)),
 ('A사장','접수대기 주문(O6) 출고 확정 → 거부','DENIED: ORDER_NOT_SHIPPABLE', pg_temp.try($q$select public.finalize_order_shipment('e5999999-0000-0000-0000-000000000006')$q$)),
 ('A사장','O16(1kg) 확정 → b4 1→0','1|0.000', pg_temp.rows($q$update public.orders set status='confirmed' where id='e5999999-0000-0000-0000-000000000016'$q$)||'|'||pg_temp.val($q$select remaining_weight::text from public.inbound_scans where trace_no='009500000004'$q$));
set request.jwt.claim.sub = '95999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A직원','직원이 b4를 0.5kg만 찍음 → 허용(현장 작업)','ALLOWED|0.500', pg_temp.rpc('X3', $q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000016', '009500000004', 0.5)$q$)||'|'||pg_temp.val($q$select payload->>'taken' from ids where key='X3'$q$)),
 ('A직원','부족분(0.5) 있는데 확인 없이 확정 → 거부','DENIED: SHIPMENT_SHORT', pg_temp.try($q$select public.finalize_order_shipment('e5999999-0000-0000-0000-000000000016')$q$)),
 ('A직원','부족 확인하고 확정 → 총액 34,000·출고량 0.5·배송중','ALLOWED|true|34000.00|0.500|shipping', pg_temp.rpc('F2', $q$select public.finalize_order_shipment('e5999999-0000-0000-0000-000000000016', true)$q$)||'|'||pg_temp.val($q$select (payload->>'was_short')||'|'||(payload->>'total_amount')||'|'||(select shipped_quantity::text from public.order_items where order_id='e5999999-0000-0000-0000-000000000016')||'|'||(select status from public.orders where id='e5999999-0000-0000-0000-000000000016') from ids where key='F2'$q$)),
 ('A직원','  └ 표시 재고 = 원장 합계(4.500)','4.500|true', pg_temp.val($q$select stock_quantity::text||'|'||(stock_quantity = (select sum(qty_delta) from public.stock_ledger where product_id=p.id))::text from public.products p where id='c5999999-0000-0000-0000-000000000001'$q$));

-- ========== 4-E. 취소 원복 / 상태 전이 규칙 (DB에 있는 것과 없는 것) ==========
set request.jwt.claim.sub = '95999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','O5(확정, b1 5+b2 3) 취소 → 원복: b1 5.000, ORDER_RESTORE 2건, 재고 12.500','1|5.000|2|12.500|true', pg_temp.rows($q$update public.orders set status='cancelled' where id='e5999999-0000-0000-0000-000000000005'$q$)||'|'||pg_temp.val($q$select (select remaining_weight::text from public.inbound_scans where trace_no='009500000001')||'|'||(select count(*) from public.stock_ledger where source_id='e5999999-0000-0000-0000-000000000005' and event_type='ORDER_RESTORE')||'|'||p.stock_quantity::text||'|'||(p.stock_quantity = (select sum(qty_delta) from public.stock_ledger where product_id=p.id))::text from public.products p where id='c5999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','취소된 O5를 다시 확정 → 거부(107 전이표), 재고 안 움직임','DENIED: INVALID_STATUS_TRANSITION|2|12.500', pg_temp.try($q$update public.orders set status='confirmed' where id='e5999999-0000-0000-0000-000000000005'$q$)||'|'||pg_temp.val($q$select (select count(*) from public.stock_ledger where source_id='e5999999-0000-0000-0000-000000000005' and event_type='ORDER_OUT')||'|'||(select stock_quantity::text from public.products where id='c5999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','배송완료 O8 → 접수대기로 되돌리기 → 거부(107)','DENIED: INVALID_STATUS_TRANSITION', pg_temp.try($q$update public.orders set status='pending' where id='e5999999-0000-0000-0000-000000000008'$q$)),
 ('A사장','배송중(출고 확정된) O7 → 취소 → 거부(107), 원복 없음','DENIED: INVALID_STATUS_TRANSITION|0', pg_temp.try($q$update public.orders set status='cancelled' where id='e5999999-0000-0000-0000-000000000007'$q$)||'|'||pg_temp.val($q$select count(*)::text from public.stock_ledger where source_id='e5999999-0000-0000-0000-000000000007' and event_type='ORDER_RESTORE'$q$)),
 ('A사장','배송중 O7 → 배송완료 → 허용 / 배송완료 → 배송중 되돌리기 → 거부','1|DENIED: INVALID_STATUS_TRANSITION', pg_temp.rows($q$update public.orders set status='delivered' where id='e5999999-0000-0000-0000-000000000007'$q$)||'|'||pg_temp.try($q$update public.orders set status='shipping' where id='e5999999-0000-0000-0000-000000000007'$q$)),
 ('A사장','접수대기 O6 → 확보대기 → 허용, 확보대기 → 배송중 건너뛰기 → 거부','1|DENIED: INVALID_STATUS_TRANSITION', pg_temp.rows($q$update public.orders set status='awaiting_stock' where id='e5999999-0000-0000-0000-000000000006'$q$)||'|'||pg_temp.try($q$update public.orders set status='shipping' where id='e5999999-0000-0000-0000-000000000006'$q$)),
 ('A사장','공급사가 취소요청 상태 생성 → 거부(바이어 전용)','DENIED: 취소 요청은 바이어만 생성할 수 있습니다. 공급사는 승인 또는 반려만 가능합니다.', pg_temp.try($q$update public.orders set status='cancel_requested' where id='e5999999-0000-0000-0000-000000000003'$q$)),
 ('A사장','취소요청 O9 → 배송중으로 → 거부','DENIED: 취소 요청은 취소 확정 또는 반려로만 종결할 수 있습니다.', pg_temp.try($q$update public.orders set status='shipping' where id='e5999999-0000-0000-0000-000000000009'$q$)),
 ('A사장','취소요청 O9 → 반려 → 허용, 종결시각 기록','1|true', pg_temp.rows($q$update public.orders set status='cancel_rejected' where id='e5999999-0000-0000-0000-000000000009'$q$)||'|'||pg_temp.val($q$select (cancel_resolved_at is not null)::text from public.orders where id='e5999999-0000-0000-0000-000000000009'$q$)),
 ('A사장','반려 후 확정 → 박스 없는 수동 재고(목살 5)에서 2 차감','1|3.000', pg_temp.rows($q$update public.orders set status='confirmed' where id='e5999999-0000-0000-0000-000000000009'$q$)||'|'||pg_temp.val($q$select stock_quantity::text from public.products where id='c5999999-0000-0000-0000-000000000003'$q$)),
 ('A사장','정해지지 않은 상태값 → 거부(CHECK)','DENIED', pg_temp.try($q$update public.orders set status='returned' where id='e5999999-0000-0000-0000-000000000003'$q$)),
 ('A사장','외상 O10(30,000, 미정산) 취소 → 미수금 50,000→20,000','1|20000', pg_temp.rows($q$update public.orders set status='cancelled' where id='e5999999-0000-0000-0000-000000000010'$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b5999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','외상 O11(정산 완료) 취소 → 미수금 그대로 20,000','1|20000', pg_temp.rows($q$update public.orders set status='cancelled' where id='e5999999-0000-0000-0000-000000000011'$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b5999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','핫딜 O12 취소 → 판매량 4→0 반환','1|0', pg_temp.rows($q$update public.orders set status='cancelled' where id='e5999999-0000-0000-0000-000000000012'$q$)||'|'||pg_temp.val($q$select hot_deal_quantity_sold::int::text from public.products where id='c5999999-0000-0000-0000-000000000005'$q$));

-- ========== 4-F. 바이어 취소 요청 ==========
set request.jwt.claim.sub = '95999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('식당R','접수대기 O14 취소요청(금액·주소 위조 동봉) → 허용, 위조값 무시','1|cancel_requested|15000|서울|true', pg_temp.rows($q$update public.orders set status='cancel_requested', total_amount=1, delivery_address='위조' where id='e5999999-0000-0000-0000-000000000014'$q$)||'|'||pg_temp.val($q$select status||'|'||total_amount::int||'|'||delivery_address||'|'||(cancel_requested_at is not null)::text from public.orders where id='e5999999-0000-0000-0000-000000000014'$q$)),
 ('식당R','확보대기 O15 취소요청 → 0행(RLS가 pending/confirmed만 열어줌, 트리거보다 먼저 걸림)','0|awaiting_stock', pg_temp.rows($q$update public.orders set status='cancel_requested' where id='e5999999-0000-0000-0000-000000000015'$q$)||'|'||pg_temp.val($q$select status from public.orders where id='e5999999-0000-0000-0000-000000000015'$q$)),
 ('식당R','배송중 O3 취소요청 → 0행(RLS: pending/confirmed만)','0', pg_temp.rows($q$update public.orders set status='cancel_requested' where id='e5999999-0000-0000-0000-000000000003'$q$)),
 ('식당R','바이어가 직접 취소 확정(O17) → 거부','DENIED: 바이어는 접수대기/확정 상태의 발주서에 대해 취소 요청만 생성할 수 있습니다.', pg_temp.try($q$update public.orders set status='cancelled' where id='e5999999-0000-0000-0000-000000000017'$q$)),
 ('식당R','바이어가 확정(O17) → 거부','DENIED: 바이어는 접수대기/확정 상태의 발주서에 대해 취소 요청만 생성할 수 있습니다.', pg_temp.try($q$update public.orders set status='confirmed' where id='e5999999-0000-0000-0000-000000000017'$q$)),
 ('식당R','바이어가 출고 확정·출고 스캔 호출 → 거부','DENIED: NOT_A_SUPPLIER|DENIED: NOT_A_SUPPLIER', pg_temp.try($q$select public.finalize_order_shipment('e5999999-0000-0000-0000-000000000016')$q$)||'|'||pg_temp.try($q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000016', '009500000004')$q$)),
 ('식당R','바이어 피킹 목록·출고 미리보기 → 0건','0|0', pg_temp.val($q$select (select count(*) from public.get_picking_list('e5999999-0000-0000-0000-000000000016'))||'|'||(select count(*) from public.preview_order_shipment('e5999999-0000-0000-0000-000000000016'))$q$));

-- ========== 4-G. 타사 격리 ==========
set request.jwt.claim.sub = '95999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('B사장','A사 주문 출고 스캔·확정 → 거부','DENIED: ORDER_NOT_FOUND|DENIED: ORDER_NOT_FOUND', pg_temp.try($q$select public.record_outbound_scan('e5999999-0000-0000-0000-000000000009', '009500000001')$q$)||'|'||pg_temp.try($q$select public.finalize_order_shipment('e5999999-0000-0000-0000-000000000009')$q$)),
 ('B사장','A사 주문 피킹·미리보기 → 0건, 상태 변경 → 0행','0|0|0', pg_temp.val($q$select (select count(*) from public.get_picking_list('e5999999-0000-0000-0000-000000000009'))||'|'||(select count(*) from public.preview_order_shipment('e5999999-0000-0000-0000-000000000009'))$q$)||'|'||pg_temp.rows($q$update public.orders set status='cancelled' where id='e5999999-0000-0000-0000-000000000009'$q$));

reset role;
select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
