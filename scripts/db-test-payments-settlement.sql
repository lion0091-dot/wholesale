-- 5. 결제·정산 통합테스트 — DB 레벨(외상 한도·정산, 결제수단 허용목록, PG 대기행, 주문 결제상태, 플랫폼 구독료 청구서)
--    PG 승인·환불·콜백은 토스 실계정이 필요해 여기서 다루지 않는다(계획 문서 5절 ⬜).
--    주문 생성 게이트·취소 원복은 db-test-orders-outbound.sql, PG 주문 유니크는 db-test-pg-idempotency.sql 이 다룬다.
--
-- 표시: "[발견]"은 지금 DB가 그렇게 동작한다는 관찰(기대값 = 현재 동작). 고치면 기대값을 바꾼다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-payments-settlement.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
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

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- ========== 시드 (접두어 97) ==========
insert into auth.users (id,email) values
 ('97999999-0000-0000-0000-000000000001','owner-a@pay.test'),
 ('97999999-0000-0000-0000-000000000002','manager-a@pay.test'),
 ('97999999-0000-0000-0000-000000000003','staff-a@pay.test'),
 ('97999999-0000-0000-0000-000000000004','retailer-r@pay.test'),
 ('97999999-0000-0000-0000-000000000005','owner-b@pay.test'),
 ('97999999-0000-0000-0000-000000000006','retailer-y@pay.test'),
 ('97999999-0000-0000-0000-000000000007','super@pay.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('97999999-0000-0000-0000-000000000001','wholesaler','A사장','010',true,true),
 ('97999999-0000-0000-0000-000000000002','wholesaler','A매니저','010',true,true),
 ('97999999-0000-0000-0000-000000000003','wholesaler','A직원','010',true,true),
 ('97999999-0000-0000-0000-000000000004','retailer','식당R','010',false,false),
 ('97999999-0000-0000-0000-000000000005','wholesaler','B사장','010',true,true),
 ('97999999-0000-0000-0000-000000000006','retailer','식당Y','010',false,false),
 ('97999999-0000-0000-0000-000000000007','super_admin','관리자','010',false,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name;
alter table public.profiles enable trigger user;
-- 최소발주금액 규칙(107)이 소액 시드를 막지 않게 0
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,min_order_amount) values
 ('a7999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000001','A축산','9790000001','A','active',0),
 ('a7999999-0000-0000-0000-000000000002','97999999-0000-0000-0000-000000000005','B축산','9790000002','B','active',0);
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('07999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','A축산','9790000001'),
 ('07999999-0000-0000-0000-000000000002','a7999999-0000-0000-0000-000000000002','B축산','9790000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('07999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000001','owner'),
 ('07999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000002','manager'),
 ('07999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000003','staff'),
 ('07999999-0000-0000-0000-000000000002','97999999-0000-0000-0000-000000000005','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d7999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000004','식당R','사장','서울'),
 ('d7999999-0000-0000-0000-000000000002','97999999-0000-0000-0000-000000000006','식당Y','사장','부산');
-- WR1: A–R (한도 100,000 / 미수금 60,000 / 허용수단 선불만) · WR2: B–Y (한도 500,000) · WR3: A–Y 거래중지
insert into public.wholesaler_retailers (id,wholesaler_id,retailer_id,status,credit_limit,outstanding_balance,allowed_payment_methods) values
 ('b7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','active',100000,60000,array['prepaid']),
 ('b7999999-0000-0000-0000-000000000002','a7999999-0000-0000-0000-000000000002','d7999999-0000-0000-0000-000000000002','active',500000,0,array['prepaid','on_credit']),
 ('b7999999-0000-0000-0000-000000000003','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000002','blocked',1000000,0,array['prepaid','on_credit']);
-- 정산·취소 시험용 주문(헤더만)
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method,settled_at,payment_status,pg_payment_key,pg_order_id) values
 ('e7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-S1',30000,'delivered','서울','on_credit',null,null,null,null),
 ('e7999999-0000-0000-0000-000000000002','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-S2',20000,'delivered','서울','on_credit',null,null,null,null),
 ('e7999999-0000-0000-0000-000000000003','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-S3',10000,'delivered','서울','on_credit',now(),null,null,null),
 ('e7999999-0000-0000-0000-000000000004','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-S4',10000,'delivered','서울','prepaid',null,null,null,null),
 ('e7999999-0000-0000-0000-000000000005','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-S6',4000,'delivered','서울','on_credit',null,null,null,null),
 ('e7999999-0000-0000-0000-000000000006','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-S7',999999,'delivered','서울','on_credit',null,null,null,null),
 ('e7999999-0000-0000-0000-000000000007','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-S8',5000,'delivered','서울','on_credit',null,null,null,null),
 ('e7999999-0000-0000-0000-000000000008','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-C1',5000,'pending','서울','on_credit',null,null,null,null),
 ('e7999999-0000-0000-0000-000000000009','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-P1',30000,'pending','서울','pg',null,'paid','pk_real','pgOrigin');
-- Y가 남긴 PG 대기행(R이 지울 수 있는지 시험용) / R의 대기행은 아래에서 세션으로 만든다
insert into public.pg_pending_payments (id,pg_order_id,wholesaler_id,retailer_id,total_amount,cart_snapshot,restaurant_name,contact_phone,delivery_address) values
 ('a8999999-0000-0000-0000-000000000001','pgY-1','a7999999-0000-0000-0000-000000000002','d7999999-0000-0000-0000-000000000002',20000,'[]'::jsonb,'식당Y','010','부산');
-- 플랫폼 구독료 청구서
insert into public.platform_subscription_invoices (id,wholesaler_id,billing_month,billed_retailer_count,full_month_fee,amount,status) values
 ('f7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','2026-09-01',5,25000,25000,'unpaid'),
 ('f7999999-0000-0000-0000-000000000002','a7999999-0000-0000-0000-000000000002','2026-09-01',3,15000,15000,'unpaid');

-- ========== 5-A. 외상 한도 (바이어 세션 R) ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','한도와 딱 같아지는 외상(60,000 + 40,000 = 100,000) → 허용','ALLOWED|100000', pg_temp.try($q$select public.apply_credit_order('b7999999-0000-0000-0000-000000000001', 40000)$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b7999999-0000-0000-0000-000000000001'$q$)),
 ('식당R','1원이라도 넘으면 → 거부, 잔액 그대로','DENIED: CREDIT_LIMIT_EXCEEDED|100000', pg_temp.try($q$select public.apply_credit_order('b7999999-0000-0000-0000-000000000001', 1)$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b7999999-0000-0000-0000-000000000001'$q$)),
 ('식당R','남의 거래관계(B–Y) ID로 외상 → 거부','DENIED: CREDIT_LIMIT_EXCEEDED', pg_temp.try($q$select public.apply_credit_order('b7999999-0000-0000-0000-000000000002', 1000)$q$)),
 ('식당R','외상 음수·0원 → 거부','DENIED: INVALID_AMOUNT|DENIED: INVALID_AMOUNT', pg_temp.try($q$select public.apply_credit_order('b7999999-0000-0000-0000-000000000001', -1)$q$)||'|'||pg_temp.try($q$select public.apply_credit_order('b7999999-0000-0000-0000-000000000001', 0)$q$)),
 ('식당R','바이어가 자기 미수금·한도 직접 UPDATE → 0행(관계 테이블 수정 정책 없음)','0|0', pg_temp.rows($q$update public.wholesaler_retailers set outstanding_balance = 0 where id='b7999999-0000-0000-0000-000000000001'$q$)||'|'||pg_temp.rows($q$update public.wholesaler_retailers set credit_limit = 99999999 where id='b7999999-0000-0000-0000-000000000001'$q$));
reset role;
update public.wholesaler_retailers set outstanding_balance = 60000 where id = 'b7999999-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('식당Y','[정보] 거래중지 관계(A–Y)에서도 외상 잔액 증가 RPC는 통과(주문은 RLS로 막히므로 잔액 부풀림만 가능)','ALLOWED|1000', pg_temp.try($q$select public.apply_credit_order('b7999999-0000-0000-0000-000000000003', 1000)$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b7999999-0000-0000-0000-000000000003'$q$)),
 ('식당Y','거래중지 관계로 A사에 주문 헤더 → 거부(RLS)','DENIED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e7999999-0000-0000-0000-000000000090','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000002','PAY-Y1',10000,'pending','부산')$q$));
set role anon; set request.jwt.claim.role = 'anon'; set request.jwt.claim.sub = '';
insert into results (who,what,expected,result) values
 ('비로그인','외상 RPC → 실행 권한 없음','DENIED: permission denied for function apply_credit_order', pg_temp.try($q$select public.apply_credit_order('b7999999-0000-0000-0000-000000000001', 1)$q$));

-- ========== 5-B. 결제수단 허용목록·결제상태 (바이어 세션 R, 허용수단은 선불만) ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','정상: 선불 주문 헤더 → 허용','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method) values ('e7999999-0000-0000-0000-000000000020','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-B1',10000,'pending','서울','prepaid')$q$)),
 ('식당R','[발견] 허용 안 된 외상으로 주문 헤더 직접 INSERT → DB가 안 막음(허용목록은 앱만 검사)','ALLOWED|60000', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method) values ('e7999999-0000-0000-0000-000000000021','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-B2',10000,'pending','서울','on_credit')$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b7999999-0000-0000-0000-000000000001'$q$)),
 ('식당R','[발견] 한도(100,000)를 넘는 외상 주문(500,000)도 apply_credit_order를 안 부르면 그대로 들어가고 미수금은 안 늘어남','ALLOWED|60000', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method) values ('e7999999-0000-0000-0000-000000000022','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-B3',500000,'pending','서울','on_credit')$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b7999999-0000-0000-0000-000000000001'$q$)),
 ('식당R','[발견] 허용 안 된 PG 주문을 결제 완료(paid)+결제키 위조로 직접 INSERT → DB가 안 막음','ALLOWED|paid|pk_fake', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method,payment_status,pg_payment_key,pg_order_id) values ('e7999999-0000-0000-0000-000000000023','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-B4',10000,'pending','서울','pg','paid','pk_fake','pgFake1')$q$)||'|'||pg_temp.val($q$select payment_status||'|'||pg_payment_key from public.orders where id='e7999999-0000-0000-0000-000000000023'$q$)),
 ('식당R','정해지지 않은 결제수단·결제상태 → 거부(CHECK)','DENIED|DENIED', left(pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method) values ('e7999999-0000-0000-0000-000000000024','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-B5',1,'pending','서울','crypto')$q$),6)||'|'||left(pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method,payment_status) values ('e7999999-0000-0000-0000-000000000025','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','PAY-B6',1,'pending','서울','prepaid','weird')$q$),6)),
 ('식당R','결제상태만 바꾸는 직접 UPDATE(취소요청 아님) → 거부','DENIED: 바이어는 접수대기/확정 상태의 발주서에 대해 취소 요청만 생성할 수 있습니다.', pg_temp.try($q$update public.orders set payment_status='refunded' where id='e7999999-0000-0000-0000-000000000009'$q$)),
 ('식당R','취소요청에 결제 컬럼을 끼워 보내도 → 취소요청은 접수(1행), 결제상태·결제키·정산시각·결제수단은 원본 유지(108)','1|paid|pk_real|false|pg', pg_temp.rows($q$update public.orders set status='cancel_requested', payment_status='refunded', pg_payment_key='forged', settled_at=now(), payment_method='on_credit' where id='e7999999-0000-0000-0000-000000000009'$q$)||'|'||pg_temp.val($q$select payment_status||'|'||pg_payment_key||'|'||(settled_at is not null)::text||'|'||payment_method from public.orders where id='e7999999-0000-0000-0000-000000000009'$q$));

-- ========== 5-C. PG 대기행 (바이어 세션 R) ==========
insert into results (who,what,expected,result) values
 ('식당R','자기 거래중 공급사(A)에 대기행 → 허용, 만료 기본 30분','ALLOWED|true', pg_temp.try($q$insert into public.pg_pending_payments (id,pg_order_id,wholesaler_id,retailer_id,total_amount,cart_snapshot,restaurant_name,contact_phone,delivery_address) values ('a8999999-0000-0000-0000-000000000002','pgR-1','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001',30000,'[]'::jsonb,'식당R','010','서울')$q$)||'|'||pg_temp.val($q$select (expires_at - created_at = interval '30 minutes')::text from public.pg_pending_payments where id='a8999999-0000-0000-0000-000000000002'$q$)),
 ('식당R','다른 식당(Y) 명의로 대기행 → 거부','DENIED', pg_temp.try($q$insert into public.pg_pending_payments (pg_order_id,wholesaler_id,retailer_id,total_amount,cart_snapshot,restaurant_name,contact_phone,delivery_address) values ('pgR-2','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000002',30000,'[]'::jsonb,'식당Y','010','부산')$q$)),
 ('식당R','거래 없는 공급사(B)에 대기행 → 거부','DENIED', pg_temp.try($q$insert into public.pg_pending_payments (pg_order_id,wholesaler_id,retailer_id,total_amount,cart_snapshot,restaurant_name,contact_phone,delivery_address) values ('pgR-3','a7999999-0000-0000-0000-000000000002','d7999999-0000-0000-0000-000000000001',30000,'[]'::jsonb,'식당R','010','서울')$q$)),
 ('식당R','같은 결제 ID 두 번 → 거부(유니크)','DENIED', pg_temp.try($q$insert into public.pg_pending_payments (pg_order_id,wholesaler_id,retailer_id,total_amount,cart_snapshot,restaurant_name,contact_phone,delivery_address) values ('pgR-1','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001',30000,'[]'::jsonb,'식당R','010','서울')$q$)),
 ('식당R','금액 0원·음수 → 거부(CHECK)','DENIED|DENIED', left(pg_temp.try($q$insert into public.pg_pending_payments (pg_order_id,wholesaler_id,retailer_id,total_amount,cart_snapshot,restaurant_name,contact_phone,delivery_address) values ('pgR-4','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001',0,'[]'::jsonb,'식당R','010','서울')$q$),6)||'|'||left(pg_temp.try($q$insert into public.pg_pending_payments (pg_order_id,wholesaler_id,retailer_id,total_amount,cart_snapshot,restaurant_name,contact_phone,delivery_address) values ('pgR-5','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001',-5,'[]'::jsonb,'식당R','010','서울')$q$),6)),
 ('식당R','[발견] 결제 금액 1,000원인데 장바구니에는 500,000원어치를 적은 대기행 → DB가 안 막음(금액·장바구니 대조 없음)','ALLOWED', pg_temp.try($q$insert into public.pg_pending_payments (pg_order_id,wholesaler_id,retailer_id,total_amount,cart_snapshot,restaurant_name,contact_phone,delivery_address) values ('pgR-6','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001',1000,'[{"productId":"c7999999-0000-0000-0000-000000000001","name":"한우 등심","unit":"kg","quantity":50,"unitPrice":10000}]'::jsonb,'식당R','010','서울')$q$)),
 ('식당R','대기행 UPDATE(금액 변조) → 0행(수정 정책 없음)','0', pg_temp.rows($q$update public.pg_pending_payments set total_amount = 1 where id='a8999999-0000-0000-0000-000000000002'$q$)),
 ('식당R','자기 대기행 조회 3건(pgR-1, pgR-6 포함)·남의 것 0건','2|0', pg_temp.val($q$select count(*)::text from public.pg_pending_payments where pg_order_id in ('pgR-1','pgR-6')$q$)||'|'||pg_temp.val($q$select count(*)::text from public.pg_pending_payments where pg_order_id='pgY-1'$q$)),
 ('식당R','남의 대기행 삭제 → 0행, 자기 것 삭제 → 1행','0|1', pg_temp.rows($q$delete from public.pg_pending_payments where id='a8999999-0000-0000-0000-000000000001'$q$)||'|'||pg_temp.rows($q$delete from public.pg_pending_payments where pg_order_id='pgR-6'$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','공급사는 자기 회사 대기행만 조회(R의 pgR-1 보임, B의 것 안 보임)','1|0', pg_temp.val($q$select count(*)::text from public.pg_pending_payments where pg_order_id='pgR-1'$q$)||'|'||pg_temp.val($q$select count(*)::text from public.pg_pending_payments where pg_order_id='pgY-1'$q$)),
 ('A사장','공급사가 대기행 삭제·수정 → 0행','0|0', pg_temp.rows($q$delete from public.pg_pending_payments where pg_order_id='pgR-1'$q$)||'|'||pg_temp.rows($q$update public.pg_pending_payments set total_amount=1 where pg_order_id='pgR-1'$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('식당Y','다른 식당의 대기행 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.pg_pending_payments where pg_order_id='pgR-1'$q$)),
 ('식당Y','거래중지 관계(A)로 대기행 → 거부','DENIED', pg_temp.try($q$insert into public.pg_pending_payments (pg_order_id,wholesaler_id,retailer_id,total_amount,cart_snapshot,restaurant_name,contact_phone,delivery_address) values ('pgY-2','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000002',10000,'[]'::jsonb,'식당Y','010','부산')$q$));

-- ========== 5-D. 외상 정산 (settle_credit_orders) — R의 미수금 60,000에서 시작 ==========
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','외상 2건(30,000+20,000) 정산 → 미수금 60,000 → 10,000','10000|2', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000001','e7999999-0000-0000-0000-000000000002']::uuid[])$q$)||'|'||pg_temp.val($q$select count(*)::text from public.orders where id in ('e7999999-0000-0000-0000-000000000001','e7999999-0000-0000-0000-000000000002') and settled_at is not null$q$)),
 ('A사장','같은 건 다시 정산 → 0행, 미수금 그대로','<null>|10000', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000001','e7999999-0000-0000-0000-000000000002']::uuid[])$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b7999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','이미 정산된 건(S3)·선불 주문(S4) 정산 → 0행','<null>|10000', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000003','e7999999-0000-0000-0000-000000000004']::uuid[])$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b7999999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','매니저 정산(4,000) → 10,000 → 6,000','6000', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000005']::uuid[])$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원','직원 정산 → 거부(owner/manager 전용)','ERROR: NOT_A_WHOLESALER', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000006']::uuid[])$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','고객 계정 정산 호출 → 거부','ERROR: NOT_A_WHOLESALER', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000006']::uuid[])$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('B사장','다른 공급사 주문 정산 → 0행, A의 주문은 미정산 그대로','<null>|0', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000007']::uuid[])$q$)||'|'||pg_temp.val($q$select count(*)::text from public.orders where id='e7999999-0000-0000-0000-000000000007' and settled_at is not null$q$));
set role anon; set request.jwt.claim.role = 'anon'; set request.jwt.claim.sub = '';
insert into results (who,what,expected,result) values
 ('비로그인','정산 RPC → 거부','ERROR: NOT_A_WHOLESALER', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000006']::uuid[])$q$));
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','미수금보다 큰 정산(999,999) → 0 미만으로 안 내려감','0', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000006']::uuid[])$q$));
reset role;
update public.wholesaler_retailers set outstanding_balance = 40000 where id = 'b7999999-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','외상 주문 C1(5,000) 취소 → 미수금 40,000 → 35,000','1|35000', pg_temp.rows($q$update public.orders set status='cancelled' where id='e7999999-0000-0000-0000-000000000008'$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b7999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','이미 취소로 되돌린 C1을 정산 처리 → 정산 대상 아님(0행), 미수금 35,000 그대로(108)','<null>|35000', pg_temp.val($q$select string_agg(new_outstanding_balance::int::text, ',') from public.settle_credit_orders(array['e7999999-0000-0000-0000-000000000008']::uuid[])$q$)||'|'||pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b7999999-0000-0000-0000-000000000001'$q$));

-- ========== 5-E. 플랫폼 구독료 청구서 ==========
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','자기 회사 청구서 조회 → 0건(청구서는 관리자만 봄)','0', pg_temp.val($q$select count(*)::text from public.platform_subscription_invoices$q$)),
 ('A사장','청구서 완납 처리 시도 → 0행','0', pg_temp.rows($q$update public.platform_subscription_invoices set status='paid' where id='f7999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','청구서 직접 INSERT → 거부','DENIED', pg_temp.try($q$insert into public.platform_subscription_invoices (wholesaler_id,billing_month,billed_retailer_count,full_month_fee,amount) values ('a7999999-0000-0000-0000-000000000001','2026-10-01',0,0,0)$q$)),
 ('A사장','자기 구독 상태를 직접 active로 변경 → 거부(102)','DENIED: PLATFORM_ONLY_COLUMN', pg_temp.try($q$update public.wholesalers set subscription_status='active' where id='a7999999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','고객 계정 청구서 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.platform_subscription_invoices$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000007';
insert into results (who,what,expected,result) values
 ('관리자','전체 청구서 조회 → 2건','2', pg_temp.val($q$select count(*)::text from public.platform_subscription_invoices$q$)),
 ('관리자','수납 확인(완납 처리) → 1행','1', pg_temp.rows($q$update public.platform_subscription_invoices set status='paid', paid_at=now(), paid_amount=25000 where id='f7999999-0000-0000-0000-000000000001'$q$)),
 ('관리자','정해지지 않은 청구서 상태 → 거부(CHECK)','DENIED', pg_temp.try($q$update public.platform_subscription_invoices set status='bogus' where id='f7999999-0000-0000-0000-000000000002'$q$)),
 ('관리자','[정보] 관리자 세션도 청구서 직접 INSERT는 정책 없음 → 거부(생성은 서버 전용)','DENIED', pg_temp.try($q$insert into public.platform_subscription_invoices (wholesaler_id,billing_month,billed_retailer_count,full_month_fee,amount) values ('a7999999-0000-0000-0000-000000000001','2026-10-01',0,0,0)$q$));
reset role;
insert into results (who,what,expected,result) values
 ('서버','같은 공급사·같은 달 청구서 두 번 → 거부(유니크)','DENIED', pg_temp.try($q$insert into public.platform_subscription_invoices (wholesaler_id,billing_month,billed_retailer_count,full_month_fee,amount) values ('a7999999-0000-0000-0000-000000000001','2026-09-01',1,1,1)$q$));

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
