-- 0. 공통(권한·격리) 통합테스트 — 테이블 RLS + 화면 우회(API 직접 호출) 가정
--    20260930000102(취소요청 정책 복원·플랫폼 컬럼 보호·내부 함수 권한 회수·핫딜 소진 가드·외상 음수 거부) 검증 포함
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-access-isolation.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
--
-- expected 칸은 "설계상 이래야 한다"를 적었다. FAIL이 나오면 그 줄이 곧 발견 사항이다.
-- expected가 'DENIED'만이면 사유 무관하게 거부되기만 하면 PASS.
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

-- "UPDATE/DELETE가 몇 행에 먹혔나" (RLS는 오류 없이 0행으로 끝난다)
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

-- ========== 시드 (이 스크립트 전용 ID 접두어 96) ==========
insert into auth.users (id,email) values
 ('96999999-0000-0000-0000-000000000001','owner-a@iso.test'),
 ('96999999-0000-0000-0000-000000000002','owner-b@iso.test'),
 ('96999999-0000-0000-0000-000000000003','retailer-r@iso.test'),
 ('96999999-0000-0000-0000-000000000004','staff-a@iso.test'),
 ('96999999-0000-0000-0000-000000000005','manager-a@iso.test'),
 ('96999999-0000-0000-0000-000000000006','super@iso.test'),
 ('96999999-0000-0000-0000-000000000007','retailer-r2@iso.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('96999999-0000-0000-0000-000000000001','wholesaler','A사장','010'),
 ('96999999-0000-0000-0000-000000000002','wholesaler','B사장','010'),
 ('96999999-0000-0000-0000-000000000003','retailer','식당R','010'),
 ('96999999-0000-0000-0000-000000000004','wholesaler','A직원','010'),
 ('96999999-0000-0000-0000-000000000005','wholesaler','A매니저','010'),
 ('96999999-0000-0000-0000-000000000006','super_admin','관리자','010'),
 ('96999999-0000-0000-0000-000000000007','retailer','식당R2','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,subscription_status,min_order_amount) values
 ('a6999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000001','A축산','9690000001','A','active','trial',0),
 ('a6999999-0000-0000-0000-000000000002','96999999-0000-0000-0000-000000000002','B축산','9690000002','B','active','trial',0);
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('06999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','A축산','9690000001'),
 ('06999999-0000-0000-0000-000000000002','a6999999-0000-0000-0000-000000000002','B축산','9690000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('06999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000004','staff'),
 ('06999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000005','manager');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d6999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000003','식당R','사장','서울'),
 ('d6999999-0000-0000-0000-000000000002','96999999-0000-0000-0000-000000000007','식당R2','사장','부산');
insert into public.wholesaler_retailers (id,wholesaler_id,retailer_id,status,credit_limit,outstanding_balance) values
 ('b6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','active',1000000,100000),
 ('b6999999-0000-0000-0000-000000000002','a6999999-0000-0000-0000-000000000002','d6999999-0000-0000-0000-000000000002','active',0,0);
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,hot_deal_active,hot_deal_price,hot_deal_quantity_limit,hot_deal_quantity_sold) values
 ('c6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','A 한우등심','소','등심','국내산','1++',68000,'kg',10,true,50000,5,0),
 ('c6999999-0000-0000-0000-000000000002','a6999999-0000-0000-0000-000000000002','B 삼겹','돼지','삼겹살','국내산',null,20000,'kg',5,false,null,null,0),
 ('c6999999-0000-0000-0000-000000000003','a6999999-0000-0000-0000-000000000001','A 삼겹(맞춤단가)','돼지','삼겹살','국내산',null,30000,'kg',10,false,null,null,0);
-- 식당R에게만 켜진 맞춤단가 25000 (기준 30000)
insert into public.custom_prices (wholesaler_id,retailer_id,product_id,custom_price,is_active) values
 ('a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','c6999999-0000-0000-0000-000000000003',25000,true);
-- A사 주문(식당R): 접수대기(핫딜) / 확정 / 배송중 / 직원테스트용 / 위조테스트용, B사 주문 1건(식당R2)
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values
 ('e6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-PENDING',50000,'pending','서울'),
 ('e6999999-0000-0000-0000-000000000002','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-CONFIRMED',68000,'confirmed','서울'),
 ('e6999999-0000-0000-0000-000000000003','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-SHIPPING',68000,'shipping','서울'),
 ('e6999999-0000-0000-0000-000000000004','a6999999-0000-0000-0000-000000000002','d6999999-0000-0000-0000-000000000002','ISO-B',20000,'pending','부산'),
 ('e6999999-0000-0000-0000-000000000005','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-STAFF',68000,'pending','서울'),
 ('e6999999-0000-0000-0000-000000000006','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-PENDING2',68000,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount,is_hot_deal) values
 ('e6999999-0000-0000-0000-000000000001','c6999999-0000-0000-0000-000000000001','A 한우등심',50000,1,50000,true),
 ('e6999999-0000-0000-0000-000000000002','c6999999-0000-0000-0000-000000000001','A 한우등심',68000,1,68000,false),
 ('e6999999-0000-0000-0000-000000000003','c6999999-0000-0000-0000-000000000001','A 한우등심',68000,1,68000,false),
 ('e6999999-0000-0000-0000-000000000004','c6999999-0000-0000-0000-000000000002','B 삼겹',20000,1,20000,false),
 ('e6999999-0000-0000-0000-000000000005','c6999999-0000-0000-0000-000000000001','A 한우등심',68000,1,68000,false),
 ('e6999999-0000-0000-0000-000000000006','c6999999-0000-0000-0000-000000000001','A 한우등심',68000,1,68000,false);

-- ========== 1. 공급사 A ↔ B 격리 (A사장) ==========
-- PostgREST가 넣어주는 role 클레임도 흉내 낸다 — 103의 품목 트리거가 auth.role()로 바이어 세션을 가려낸다.
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','B사 상품 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.products where wholesaler_id='a6999999-0000-0000-0000-000000000002'$q$)),
 ('A사장','B사 주문 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.orders where wholesaler_id='a6999999-0000-0000-0000-000000000002'$q$)),
 ('A사장','B사 주문 품목 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.order_items where order_id='e6999999-0000-0000-0000-000000000004'$q$)),
 ('A사장','B사 거래처(식당R2) 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.retailers where id='d6999999-0000-0000-0000-000000000002'$q$)),
 ('A사장','B사 거래관계 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.wholesaler_retailers where wholesaler_id='a6999999-0000-0000-0000-000000000002'$q$)),
 ('A사장','B사 회사정보 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.wholesalers where id='a6999999-0000-0000-0000-000000000002'$q$)),
 ('A사장','B사 직원 목록 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.organization_staff where organization_id='06999999-0000-0000-0000-000000000002'$q$)),
 ('A사장','B사 상품 가격 수정 → 0행','0', pg_temp.rows($q$update public.products set base_price=1 where id='c6999999-0000-0000-0000-000000000002'$q$)),
 ('A사장','B사 주문 상태 변경 → 0행','0', pg_temp.rows($q$update public.orders set status='cancelled' where id='e6999999-0000-0000-0000-000000000004'$q$)),
 ('A사장','B사 상품 삭제 → 0행','0', pg_temp.rows($q$delete from public.products where id='c6999999-0000-0000-0000-000000000002'$q$)),
 ('A사장','B사 거래처 여신한도 수정 → 0행','0', pg_temp.rows($q$update public.wholesaler_retailers set credit_limit=9999999 where wholesaler_id='a6999999-0000-0000-0000-000000000002'$q$)),
 ('A사장','자기 회사 최소발주금액 수정(허용) → 1행','1', pg_temp.rows($q$update public.wholesalers set min_order_amount=0 where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','자기 회사 대표자명·주소 수정(허용) → 1행','1', pg_temp.rows($q$update public.wholesalers set representative_name='A2', business_address='서울 어딘가' where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','자기 회사 구독상태를 직접 active로(플랫폼 전용) → 거부','ERROR: PLATFORM_ONLY_COLUMN', pg_temp.rows($q$update public.wholesalers set subscription_status='active' where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','자기 회사 무료체험 시작일 연장(플랫폼 전용) → 거부','ERROR: PLATFORM_ONLY_COLUMN', pg_temp.rows($q$update public.wholesalers set trial_started_at=now() + interval '30 days' where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','자기 회사 국세청검증 상태를 직접 match로 → 거부','ERROR: PLATFORM_ONLY_COLUMN', pg_temp.rows($q$update public.wholesalers set nts_verification_status='match', nts_verified_at=now() where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','자기 회사 승인상태(status) 직접 변경 → 거부','ERROR: PLATFORM_ONLY_COLUMN', pg_temp.rows($q$update public.wholesalers set status='suspended' where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','자기 회사 사업자번호 변경 → 거부','ERROR: PLATFORM_ONLY_COLUMN', pg_temp.rows($q$update public.wholesalers set business_number='1234567890' where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','자기 role을 super_admin으로 → 거부','DENIED: 역할(role)은 스스로 변경할 수 없습니다.', pg_temp.try($q$update public.profiles set role='super_admin' where id='96999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','다른 사람 프로필 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.profiles where id<>'96999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','플랫폼 청구서 테이블 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.platform_subscription_invoices$q$)),
 ('A사장','내부 재고함수 직접 호출(자기 주문) → 거부','DENIED: permission denied for function apply_order_shipment', pg_temp.try($q$select public.apply_order_shipment('e6999999-0000-0000-0000-000000000002')$q$));

-- ========== 2. 직원 등급 (A직원 staff / A매니저 manager) ==========
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('A직원','자기 회사 상품 조회 → 2건','2', pg_temp.val($q$select count(*)::text from public.products where wholesaler_id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A직원','자기 회사 주문 조회 → 5건','5', pg_temp.val($q$select count(*)::text from public.orders where wholesaler_id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A직원','B사 상품 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.products where wholesaler_id='a6999999-0000-0000-0000-000000000002'$q$)),
 ('A직원','상품 가격 수정(owner/manager 전용) → 0행','0', pg_temp.rows($q$update public.products set base_price=1 where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('A직원','상품 신규 등록 → 거부','DENIED: new row violates row-level security policy for table "products"', pg_temp.try($q$insert into public.products (wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity) values ('a6999999-0000-0000-0000-000000000001','직원등록','소','안심','국내산',1,'kg',0)$q$)),
 ('A직원','상품 삭제 → 0행','0', pg_temp.rows($q$delete from public.products where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('A직원','거래처 여신한도 수정 → 0행','0', pg_temp.rows($q$update public.wholesaler_retailers set credit_limit=9999999 where wholesaler_id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A직원','회사 설정(최소발주금액) 수정 → 0행','0', pg_temp.rows($q$update public.wholesalers set min_order_amount=1 where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A직원','자기 역할을 owner로 승격 → 0행','0', pg_temp.rows($q$update public.organization_staff set role='owner' where user_id='96999999-0000-0000-0000-000000000004'$q$)),
 ('A직원','직원 추가(초대 우회) → 거부','DENIED: new row violates row-level security policy for table "organization_staff"', pg_temp.try($q$insert into public.organization_staff (organization_id,user_id,role) values ('06999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000007','staff')$q$)),
 ('A직원','매니저 제거 → 0행','0', pg_temp.rows($q$delete from public.organization_staff where user_id='96999999-0000-0000-0000-000000000005'$q$)),
 ('A직원','주문 상태 변경(직원 허용 설계) → 1행','1', pg_temp.rows($q$update public.orders set status='awaiting_stock' where id='e6999999-0000-0000-0000-000000000005'$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('A매니저','상품 가격 수정(허용) → 1행','1', pg_temp.rows($q$update public.products set base_price=69000 where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('A매니저','거래처 여신한도 수정(허용) → 1행','1', pg_temp.rows($q$update public.wholesaler_retailers set credit_limit=2000000 where wholesaler_id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('A매니저','자기 역할을 owner로 승격 → 0행','0', pg_temp.rows($q$update public.organization_staff set role='owner' where user_id='96999999-0000-0000-0000-000000000005'$q$)),
 ('A매니저','회사 설정(최소발주금액) 수정 → 0행(사장 전용)','0', pg_temp.rows($q$update public.wholesalers set min_order_amount=1 where id='a6999999-0000-0000-0000-000000000001'$q$));

-- ========== 3. super_admin ==========
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('관리자','A사 상품 조회(전체 열람 설계) → 2건','2', pg_temp.val($q$select count(*)::text from public.products where wholesaler_id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('관리자','A·B사 주문 조회 → 6건(직접 INSERT 테스트 전)','6', pg_temp.val($q$select count(*)::text from public.orders where order_number like 'ISO-%'$q$)),
 ('관리자','A사 승인상태 변경(허용) → 1행','1', pg_temp.rows($q$update public.wholesalers set status='suspended' where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('관리자','원복','1', pg_temp.rows($q$update public.wholesalers set status='active' where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('관리자','A사 구독상태 변경(허용) → 1행','1', pg_temp.rows($q$update public.wholesalers set subscription_status='active', billing_starts_at=now() where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('관리자','플랫폼 청구서 테이블 조회 → 오류 없음','0', pg_temp.val($q$select count(*)::text from public.platform_subscription_invoices where wholesaler_id='a6999999-0000-0000-0000-000000000001'$q$));

-- ========== 4. 바이어(식당R) vs 공급사 ==========
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('고객','거래중 A사 상품 조회 → 2건','2', pg_temp.val($q$select count(*)::text from public.products where wholesaler_id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','거래 없는 B사 상품 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.products where wholesaler_id='a6999999-0000-0000-0000-000000000002'$q$)),
 ('고객','자기 주문 조회 → 5건','5', pg_temp.val($q$select count(*)::text from public.orders where retailer_id='d6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','다른 식당 주문 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.orders where retailer_id='d6999999-0000-0000-0000-000000000002'$q$)),
 ('고객','A사 재고 원장/입고 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.stock_ledger where wholesaler_id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','A사 직원 목록 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.organization_staff where organization_id='06999999-0000-0000-0000-000000000001'$q$)),
 ('고객','A사 상품 가격 수정 → 0행','0', pg_temp.rows($q$update public.products set base_price=1 where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','A사 상품 핫딜 판매량 리셋 → 0행','0', pg_temp.rows($q$update public.products set hot_deal_quantity_sold=0 where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','자기 미수금 잔액 수정 → 0행','0', pg_temp.rows($q$update public.wholesaler_retailers set outstanding_balance=0, credit_limit=99999999 where retailer_id='d6999999-0000-0000-0000-000000000001'$q$)),
 -- 핫딜 한도 소진 RPC (정상 경로 = 발주 생성 직후 서버가 1회 호출)
 ('고객','핫딜 소진: 자기 접수대기 주문 1회 → 허용','ALLOWED', pg_temp.try($q$select public.reserve_hot_deal_quota('e6999999-0000-0000-0000-000000000001')$q$)),
 ('고객','  └ 판매량 1','1', pg_temp.val($q$select hot_deal_quantity_sold::int::text from public.products where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','핫딜 소진: 같은 주문 두 번째 호출 → 조용히 무시(103, 멱등)','ALLOWED', pg_temp.try($q$select public.reserve_hot_deal_quota('e6999999-0000-0000-0000-000000000001')$q$)),
 ('고객','  └ 판매량 그대로 1','1', pg_temp.val($q$select hot_deal_quantity_sold::int::text from public.products where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','핫딜 소진: 확정된 주문으로 호출 → 거부','DENIED: ORDER_NOT_PENDING', pg_temp.try($q$select public.reserve_hot_deal_quota('e6999999-0000-0000-0000-000000000002')$q$)),
 -- 주문 위조·상태 조작
 ('고객','접수대기 주문 금액만 위조 → 거부','DENIED: 바이어는 접수대기/확정 상태의 발주서에 대해 취소 요청만 생성할 수 있습니다.', pg_temp.try($q$update public.orders set total_amount=1 where id='e6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','접수대기 주문을 직접 확정 → 거부','DENIED: 바이어는 접수대기/확정 상태의 발주서에 대해 취소 요청만 생성할 수 있습니다.', pg_temp.try($q$update public.orders set status='confirmed' where id='e6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','접수대기 주문 취소요청(정상 경로) → 1행','1', pg_temp.rows($q$update public.orders set status='cancel_requested', cancel_reason='사정' where id='e6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','취소요청 상태 주문을 다시 접수대기로 되돌리기 → 0행','0', pg_temp.rows($q$update public.orders set status='pending' where id='e6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','접수대기 주문 취소요청 + 금액·배송지 위조 → 요청은 됨','1', pg_temp.rows($q$update public.orders set status='cancel_requested', total_amount=1, delivery_address='위조' where id='e6999999-0000-0000-0000-000000000006'$q$)),
 ('고객','  └ 위조한 금액·배송지는 무시됐나','68000|서울', pg_temp.val($q$select total_amount::int::text||'|'||delivery_address from public.orders where id='e6999999-0000-0000-0000-000000000006'$q$)),
 ('고객','확정 주문 취소요청 → 1행','1', pg_temp.rows($q$update public.orders set status='cancel_requested', cancel_reason='사정' where id='e6999999-0000-0000-0000-000000000002'$q$)),
 ('고객','배송중 주문 취소요청 → 0행','0', pg_temp.rows($q$update public.orders set status='cancel_requested' where id='e6999999-0000-0000-0000-000000000003'$q$)),
 ('고객','배송중 주문 직접 취소 → 0행','0', pg_temp.rows($q$update public.orders set status='cancelled' where id='e6999999-0000-0000-0000-000000000003'$q$)),
 ('고객','배송중 주문 배송지 변경 → 0행','0', pg_temp.rows($q$update public.orders set delivery_address='딴곳' where id='e6999999-0000-0000-0000-000000000003'$q$)),
 ('고객','주문 삭제 → 0행','0', pg_temp.rows($q$delete from public.orders where id='e6999999-0000-0000-0000-000000000003'$q$)),
 ('고객','거래 없는 B사에 주문 생성 → 거부','DENIED: new row violates row-level security policy for table "orders"', pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('a6999999-0000-0000-0000-000000000002','d6999999-0000-0000-0000-000000000001','ISO-FORGE-B',1,'pending','서울')$q$)),
 -- 주문·품목 직접 INSERT (103 품목 무결성 트리거) — 헤더만으론 검증할 게 없어 통과되고, 품목에서 걸린다.
 ('고객','총액 1원 주문 헤더 직접 생성 → 헤더는 들어감','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e6999999-0000-0000-0000-000000000009','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-FORGE-A',1,'pending','서울')$q$)),
 ('고객','  └ 단가 1원 품목 → 거부','DENIED: PRICE_MISMATCH', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000009','c6999999-0000-0000-0000-000000000001','A 한우등심',1,10,10)$q$)),
 ('고객','  └ 제값 품목(69000)인데 총액은 1원 → 거부','DENIED: ORDER_TOTAL_MISMATCH', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000009','c6999999-0000-0000-0000-000000000001','A 한우등심',69000,1,69000)$q$)),
 ('고객','정상 주문 헤더(총액 69000)','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e6999999-0000-0000-0000-000000000010','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-OK',69000,'pending','서울')$q$)),
 ('고객','  └ 수량 0 품목 → 거부','DENIED: INVALID_QUANTITY', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000010','c6999999-0000-0000-0000-000000000001','A 한우등심',69000,0,0)$q$)),
 ('고객','  └ 소계 위조(69000×1=1원) → 거부','DENIED: SUBTOTAL_MISMATCH', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000010','c6999999-0000-0000-0000-000000000001','A 한우등심',69000,1,1)$q$)),
 ('고객','  └ B사 상품을 A사 주문에 → 거부','DENIED: PRODUCT_NOT_FOUND', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000010','c6999999-0000-0000-0000-000000000002','B 삼겹',20000,1,20000)$q$)),
 ('고객','  └ 핫딜가(50000)를 일반 줄로 → 거부','DENIED: PRICE_MISMATCH', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount,is_hot_deal) values ('e6999999-0000-0000-0000-000000000010','c6999999-0000-0000-0000-000000000001','A 한우등심',50000,1,50000,false)$q$)),
 ('고객','  └ 기준가 제값 품목(69000×1) → 허용','ALLOWED', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000010','c6999999-0000-0000-0000-000000000001','A 한우등심',69000,1,69000)$q$)),
 ('고객','  └ 이미 총액만큼 담긴 주문에 품목 추가 → 거부','DENIED: ORDER_TOTAL_MISMATCH', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000010','c6999999-0000-0000-0000-000000000001','A 한우등심',69000,1,69000)$q$)),
 ('고객','맞춤단가 상품 주문 헤더(총액 30000)','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e6999999-0000-0000-0000-000000000011','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-CUSTOM',30000,'pending','서울')$q$)),
 ('고객','맞춤단가 상품: 기준가(30000)로 넣기 → 거부','DENIED: PRICE_MISMATCH', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000011','c6999999-0000-0000-0000-000000000003','A 삼겹',30000,1,30000)$q$)),
 ('고객','맞춤단가 상품: 맞춤가(25000)로 넣기 → 허용','ALLOWED', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000011','c6999999-0000-0000-0000-000000000003','A 삼겹',25000,1,25000)$q$)),
 ('고객','핫딜 줄 직접 삽입(50000×2, reserve 호출 없이) → 허용 + 한도 즉시 소진','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e6999999-0000-0000-0000-000000000012','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-HOT',100000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount,is_hot_deal) values ('e6999999-0000-0000-0000-000000000012','c6999999-0000-0000-0000-000000000001','A 한우등심',50000,2,100000,true)$q$)),
 ('고객','  └ 판매량 1+2=3','3', pg_temp.val($q$select hot_deal_quantity_sold::int::text from public.products where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','  └ 그 뒤 서버의 reserve 호출은 no-op','ALLOWED', pg_temp.try($q$select public.reserve_hot_deal_quota('e6999999-0000-0000-0000-000000000012')$q$)),
 ('고객','  └ 판매량 그대로 3','3', pg_temp.val($q$select hot_deal_quantity_sold::int::text from public.products where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','핫딜 줄 한도 초과(남은 2, 담기 3) → 거부','DENIED: HOT_DEAL_QUOTA_EXCEEDED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e6999999-0000-0000-0000-000000000013','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','ISO-HOT2',150000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount,is_hot_deal) values ('e6999999-0000-0000-0000-000000000013','c6999999-0000-0000-0000-000000000001','A 한우등심',50000,3,150000,true)$q$)),
 ('고객','취소요청된 주문에 품목 추가 → 거부','DENIED: ORDER_NOT_PENDING', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000001','c6999999-0000-0000-0000-000000000001','A 한우등심',69000,1,69000)$q$)),
 -- 실패 주문 정리 RPC (103)
 ('고객','빈 1원 주문 정리 → 허용','ALLOWED', pg_temp.try($q$select public.discard_unfulfilled_order('e6999999-0000-0000-0000-000000000009')$q$)),
 ('고객','  └ 지워졌나 → 0건','0', pg_temp.val($q$select count(*)::text from public.orders where id='e6999999-0000-0000-0000-000000000009'$q$)),
 ('고객','한도 소진된 핫딜 주문 정리(외상 실패 상황) → 허용','ALLOWED', pg_temp.try($q$select public.discard_unfulfilled_order('e6999999-0000-0000-0000-000000000012')$q$)),
 ('고객','  └ 한도 돌아왔나 3-2=1','1', pg_temp.val($q$select hot_deal_quantity_sold::int::text from public.products where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','확정 주문 정리 시도 → 거부','DENIED: ORDER_NOT_PENDING', pg_temp.try($q$select public.discard_unfulfilled_order('e6999999-0000-0000-0000-000000000002')$q$)),
 ('고객','정리 안 된 정상 주문 그대로 → 1건','1', pg_temp.val($q$select count(*)::text from public.orders where id='e6999999-0000-0000-0000-000000000010'$q$)),
 -- 내부 재고 함수·대시보드 RPC
 ('고객','자기 주문으로 재고차감 RPC 직접 호출 → 거부','DENIED: permission denied for function apply_order_shipment', pg_temp.try($q$select public.apply_order_shipment('e6999999-0000-0000-0000-000000000003')$q$)),
 ('고객','  └ A사 재고 그대로(10)','10', pg_temp.val($q$select stock_quantity::int::text from public.products where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','재고원복 RPC 직접 호출 → 거부','DENIED: permission denied for function reverse_order_shipment', pg_temp.try($q$select public.reverse_order_shipment('e6999999-0000-0000-0000-000000000003')$q$)),
 ('고객','대시보드 재고조정 RPC → 거부','DENIED: PRODUCT_NOT_FOUND', pg_temp.try($q$select public.adjust_product_stock('c6999999-0000-0000-0000-000000000001', 0, 'STOCKTAKE')$q$)),
 -- 외상 RPC
 ('고객','외상 RPC 음수 금액 → 거부','DENIED: INVALID_AMOUNT', pg_temp.try($q$select public.apply_credit_order('b6999999-0000-0000-0000-000000000001', -100000)$q$)),
 ('고객','외상 RPC 0원 → 거부','DENIED: INVALID_AMOUNT', pg_temp.try($q$select public.apply_credit_order('b6999999-0000-0000-0000-000000000001', 0)$q$)),
 ('고객','외상 RPC 정상 금액(한도 내) → 허용','ALLOWED', pg_temp.try($q$select public.apply_credit_order('b6999999-0000-0000-0000-000000000001', 50000)$q$)),
 ('고객','  └ 미수금 150000','150000', pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b6999999-0000-0000-0000-000000000001'$q$)),
 ('고객','외상 RPC 한도 초과 → 거부','DENIED: CREDIT_LIMIT_EXCEEDED', pg_temp.try($q$select public.apply_credit_order('b6999999-0000-0000-0000-000000000001', 5000000)$q$));
-- 식당R2(B사 거래처)가 식당R 것으로 시도
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000007';
insert into results (who,what,expected,result) values
 ('다른 고객','남의 거래관계 ID로 외상 RPC 호출 → 거부','DENIED: CREDIT_LIMIT_EXCEEDED', pg_temp.try($q$select public.apply_credit_order('b6999999-0000-0000-0000-000000000001', 50000)$q$)),
 ('다른 고객','남의 주문 ID로 핫딜 소진 RPC 호출 → 거부','DENIED: ORDER_NOT_FOUND', pg_temp.try($q$select public.reserve_hot_deal_quota('e6999999-0000-0000-0000-000000000006')$q$)),
 ('다른 고객','남의 주문 정리 RPC 호출 → 거부','DENIED: ORDER_NOT_FOUND', pg_temp.try($q$select public.discard_unfulfilled_order('e6999999-0000-0000-0000-000000000010')$q$)),
 ('다른 고객','남의 주문에 품목 삽입 → 거부','DENIED', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e6999999-0000-0000-0000-000000000010','c6999999-0000-0000-0000-000000000001','A 한우등심',69000,1,69000)$q$));

-- ========== 5. 서버(service_role) — 재대조 크론 경로 ==========
set role service_role; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'service_role';
insert into results (who,what,expected,result) values
 ('서버','핫딜 소진 RPC(소유자 없이, 크론 경로) → 허용','ALLOWED', pg_temp.try($q$select public.reserve_hot_deal_quota('e6999999-0000-0000-0000-000000000004')$q$)),
 ('서버','공급사 구독상태 변경(크론·관리 서버 경로) → 1행','1', pg_temp.rows($q$update public.wholesalers set subscription_status='trial' where id='a6999999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.role = '';

-- ========== 6. 비로그인(anon) ==========
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','상품 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.products where wholesaler_id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('비로그인','주문 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.orders where order_number like 'ISO-%'$q$)),
 ('비로그인','공급사 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.wholesalers where id='a6999999-0000-0000-0000-000000000001'$q$)),
 ('비로그인','프로필 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.profiles where name like 'A%'$q$)),
 ('비로그인','상품 수정 → 0행','0', pg_temp.rows($q$update public.products set base_price=1 where id='c6999999-0000-0000-0000-000000000001'$q$)),
 ('비로그인','재고차감 RPC 호출(주문ID만 알면) → 거부','DENIED: permission denied for function apply_order_shipment', pg_temp.try($q$select public.apply_order_shipment('e6999999-0000-0000-0000-000000000002')$q$)),
 ('비로그인','재고원복 RPC 호출 → 거부','DENIED: permission denied for function reverse_order_shipment', pg_temp.try($q$select public.reverse_order_shipment('e6999999-0000-0000-0000-000000000002')$q$)),
 ('비로그인','재고 재계산 RPC 호출 → 거부','DENIED: permission denied for function recalc_product_stock', pg_temp.try($q$select public.recalc_product_stock('c6999999-0000-0000-0000-000000000001')$q$)),
 ('비로그인','핫딜 한도 반환 RPC 호출 → 거부','DENIED: permission denied for function release_hot_deal_quota', pg_temp.try($q$select public.release_hot_deal_quota('e6999999-0000-0000-0000-000000000001')$q$)),
 ('비로그인','핫딜 한도 소진 RPC 호출 → 거부','DENIED: permission denied for function reserve_hot_deal_quota', pg_temp.try($q$select public.reserve_hot_deal_quota('e6999999-0000-0000-0000-000000000001')$q$)),
 ('비로그인','외상 RPC 호출 → 거부','DENIED: permission denied for function apply_credit_order', pg_temp.try($q$select public.apply_credit_order('b6999999-0000-0000-0000-000000000001', 1)$q$)),
 ('비로그인','입고 스캔 RPC 호출 → 거부','DENIED: NOT_A_SUPPLIER', pg_temp.try($q$select public.record_inbound_scan('009699999901', 8.000, 'MANUAL', 'c6999999-0000-0000-0000-000000000001')$q$)),
 ('비로그인','주문 정리 RPC 호출 → 거부','DENIED: permission denied for function discard_unfulfilled_order', pg_temp.try($q$select public.discard_unfulfilled_order('e6999999-0000-0000-0000-000000000010')$q$));

reset role;
select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
select '--- 시도 뒤 실제 값: 재고 10 / 핫딜판매량 1 / 미수금 150000 ---' as t;
select stock_quantity, hot_deal_quantity_sold from public.products where id='c6999999-0000-0000-0000-000000000001';
select outstanding_balance from public.wholesaler_retailers where id='b6999999-0000-0000-0000-000000000001';
select order_number, status, total_amount from public.orders where order_number like 'ISO-%' order by order_number;
