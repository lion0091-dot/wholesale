-- 2. 상품 관리 통합테스트 — DB 레벨(삭제/보관 게이트, 거래처별 개별가격, 발주정지, 정체성 잠금·유니크)
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-product-management.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
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

-- ========== 시드 (접두어 93) ==========
insert into auth.users (id,email) values
 ('93999999-0000-0000-0000-000000000001','owner-a@prod.test'),
 ('93999999-0000-0000-0000-000000000002','manager-a@prod.test'),
 ('93999999-0000-0000-0000-000000000003','staff-a@prod.test'),
 ('93999999-0000-0000-0000-000000000004','retailer-r@prod.test'),
 ('93999999-0000-0000-0000-000000000005','owner-b@prod.test'),
 ('93999999-0000-0000-0000-000000000006','retailer-r2@prod.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('93999999-0000-0000-0000-000000000001','wholesaler','A사장','010',true,true),
 ('93999999-0000-0000-0000-000000000002','wholesaler','A매니저','010',true,true),
 ('93999999-0000-0000-0000-000000000003','wholesaler','A직원','010',true,true),
 ('93999999-0000-0000-0000-000000000004','retailer','식당R','010',false,false),
 ('93999999-0000-0000-0000-000000000005','wholesaler','B사장','010',true,true),
 ('93999999-0000-0000-0000-000000000006','retailer','식당R2','010',false,false)
 on conflict (id) do update set role=excluded.role, name=excluded.name;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a3999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000001','A축산','9390000001','A','active'),
 ('a3999999-0000-0000-0000-000000000002','93999999-0000-0000-0000-000000000005','B축산','9390000002','B','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('03999999-0000-0000-0000-000000000001','a3999999-0000-0000-0000-000000000001','A축산','9390000001'),
 ('03999999-0000-0000-0000-000000000002','a3999999-0000-0000-0000-000000000002','B축산','9390000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('03999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000001','owner'),
 ('03999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000002','manager'),
 ('03999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000003','staff'),
 ('03999999-0000-0000-0000-000000000002','93999999-0000-0000-0000-000000000005','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d3999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000004','식당R','사장','서울'),
 ('d3999999-0000-0000-0000-000000000002','93999999-0000-0000-0000-000000000006','식당R2','사장','부산');
insert into public.wholesaler_retailers (id,wholesaler_id,retailer_id,status) values
 ('b3999999-0000-0000-0000-000000000001','a3999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','active'),
 ('b3999999-0000-0000-0000-000000000002','a3999999-0000-0000-0000-000000000002','d3999999-0000-0000-0000-000000000002','active');
-- P1 거래 있음(주문) / P2 재고 기록만 / P3 아무 기록 없음 / P4·P5 예비 상품 / P6 발주정지·개별가격용 / PB B사 상품
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity) values
 ('c3999999-0000-0000-0000-000000000001','a3999999-0000-0000-0000-000000000001','P1 등심','소','등심','국내산',68000,'kg',10),
 ('c3999999-0000-0000-0000-000000000002','a3999999-0000-0000-0000-000000000002','PB 삼겹','돼지','삼겹살','국내산',20000,'kg',5),
 ('c3999999-0000-0000-0000-000000000003','a3999999-0000-0000-0000-000000000001','P3 안심','소','안심','국내산',90000,'kg',0),
 ('c3999999-0000-0000-0000-000000000004','a3999999-0000-0000-0000-000000000001','P4 구성품','돼지','목살','국내산',15000,'kg',0),
 ('c3999999-0000-0000-0000-000000000005','a3999999-0000-0000-0000-000000000001','P5 예비','돼지','앞다리살','국내산',0,'kg',0),
 ('c3999999-0000-0000-0000-000000000006','a3999999-0000-0000-0000-000000000001','P6 삼겹','돼지','삼겹살','국내산',30000,'kg',10),
 ('c3999999-0000-0000-0000-000000000007','a3999999-0000-0000-0000-000000000001','P2 갈비','소','갈비','국내산',50000,'kg',0);
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values
 ('e3999999-0000-0000-0000-000000000001','a3999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','PROD-1',68000,'delivered','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('e3999999-0000-0000-0000-000000000001','c3999999-0000-0000-0000-000000000001','P1 등심',68000,1,68000);

-- 107(최소발주금액 DB 규칙): 이 스크립트는 소액 주문으로 품목 규칙을 검사하므로 시드 공급사의 최소금액을 0으로 둔다.
update public.wholesalers set min_order_amount = 0 where id in ('a3999999-0000-0000-0000-000000000001','a3999999-0000-0000-0000-000000000002');
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000001';
-- P2에 재고 기록만 만든다(관리자 재고 조정 → stock_ledger)
select public.adjust_product_stock('c3999999-0000-0000-0000-000000000007', 3, 'STOCKTAKE', '시드') as seed_p2_ledger;

-- ========== 2-A. 삭제 vs 보관 ==========
insert into results (who,what,expected,result) values
 ('A사장','거래(주문) 있는 상품 완전삭제 → DB가 막음(FK)','DENIED: update or delete on table "products" violates foreign key constraint "order_items_product_id_fkey" on table "order_items"', pg_temp.try($q$delete from public.products where id='c3999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','재고 기록만 있는 상품 완전삭제 → DB가 막음(FK)','DENIED', pg_temp.try($q$delete from public.products where id='c3999999-0000-0000-0000-000000000007'$q$)),
 ('A사장','  └ product_has_stock_history(P2)=true (앱은 삭제 전 이걸로 보관 유도)','true', pg_temp.val($q$select public.product_has_stock_history('c3999999-0000-0000-0000-000000000007')::text$q$)),
 ('A사장','  └ product_has_stock_history(P3)=false','false', pg_temp.val($q$select public.product_has_stock_history('c3999999-0000-0000-0000-000000000003')::text$q$)),
 ('A사장','거래 있는 상품 보관 처리 → 허용','ALLOWED', pg_temp.try($q$select public.set_product_archived('c3999999-0000-0000-0000-000000000001', true)$q$)),
 ('A사장','  └ 보관됨 + 판매 꺼짐','true|false', pg_temp.val($q$select (archived_at is not null)||'|'||is_active from public.products where id='c3999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','보관 상품 가격 일괄변경 → not_found(보관은 제외)','1', pg_temp.val($q$select (public.bulk_update_product_prices('[{"id":"c3999999-0000-0000-0000-000000000001","price":70000}]'::jsonb))->>'not_found'$q$)),
 ('A사장','보관 해제 → 판매는 꺼진 채로 복귀','false|false', pg_temp.val($q$select ((select public.set_product_archived('c3999999-0000-0000-0000-000000000001', false)) is null)||'|'||(select is_active from public.products where id='c3999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','다시 보관(아래 고객 테스트용)','ALLOWED', pg_temp.try($q$select public.set_product_archived('c3999999-0000-0000-0000-000000000001', true)$q$));

-- ========== 2-B. 정체성(축종·상품명·원산지) 잠금 — 현재 DB 현황(정보) ==========
insert into results (who,what,expected,result) values
 ('A사장','같은 축종·부위·등급·원산지의 소 상품을 또 등록 → DB 유니크가 거부(마이그레이션 121)','DENIED: duplicate key value violates unique constraint "idx_products_cattle_identity"', pg_temp.try($q$insert into public.products (id,wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity) values ('c3999999-0000-0000-0000-000000000008','a3999999-0000-0000-0000-000000000001','P1 등심 복사','소','등심','국내산',31000,'kg',0)$q$)),
 ('A사장','돼지는 수동 등록 상품(trace_key 없음)이라 DB 유니크 대상이 아님 — 앱이 손 등록을 막는다(정보)','ALLOWED', pg_temp.try($q$insert into public.products (id,wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity) values ('c3999999-0000-0000-0000-000000000009','a3999999-0000-0000-0000-000000000001','P6 삼겹','돼지','삼겹살','국내산',31000,'kg',0)$q$)),
 ('A사장','거래 있는 상품의 축종·원산지 직접 변경 → DB 잠금 없음(앱 폼에서만 읽기전용, 정보)','1', pg_temp.rows($q$update public.products set category='돼지', origin='수입산' where id='c3999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','  └ 원복','1', pg_temp.rows($q$update public.products set category='소', origin='국내산' where id='c3999999-0000-0000-0000-000000000001'$q$));

-- ========== 2-D. 거래처별 개별가격 ==========
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','식당R에 P6 개별가격 25000 등록 → 허용','ALLOWED', pg_temp.try($q$insert into public.custom_prices (id,wholesaler_id,organization_id,retailer_id,product_id,custom_price,is_active) values ('f3999999-0000-0000-0000-000000000001','a3999999-0000-0000-0000-000000000001','03999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','c3999999-0000-0000-0000-000000000006',25000,true)$q$)),
 ('A사장','같은 식당·같은 상품 중복 등록 → 거부(유니크)','DENIED: duplicate key value violates unique constraint "custom_prices_retailer_id_product_id_key"', pg_temp.try($q$insert into public.custom_prices (wholesaler_id,organization_id,retailer_id,product_id,custom_price,is_active) values ('a3999999-0000-0000-0000-000000000001','03999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','c3999999-0000-0000-0000-000000000006',24000,true)$q$)),
 ('A사장','B사 식당(R2)에 A사 상품 개별가격 → 거부돼야','DENIED', pg_temp.try($q$insert into public.custom_prices (wholesaler_id,organization_id,retailer_id,product_id,custom_price,is_active) values ('a3999999-0000-0000-0000-000000000002','03999999-0000-0000-0000-000000000002','d3999999-0000-0000-0000-000000000002','c3999999-0000-0000-0000-000000000006',1,true)$q$)),
 ('A사장','기준가 일괄변경: 정상 1건 + 0원 1건 + 남의 상품 1건','1|1|1', pg_temp.val($q$select r->>'updated'||'|'||(r->>'skipped')||'|'||(r->>'not_found') from public.bulk_update_product_prices('[{"id":"c3999999-0000-0000-0000-000000000006","price":32000},{"id":"c3999999-0000-0000-0000-000000000003","price":0},{"id":"c3999999-0000-0000-0000-000000000002","price":1}]'::jsonb) r$q$)),
 ('A사장','  └ P6 기준가 32000','32000', pg_temp.val($q$select base_price::int::text from public.products where id='c3999999-0000-0000-0000-000000000006'$q$)),
 ('A사장','판매 꺼진 상품 일괄변경 + 활성화 옵션 → updated 1','1', pg_temp.val($q$select (public.bulk_update_product_prices('[{"id":"c3999999-0000-0000-0000-000000000003","price":91000}]'::jsonb, true))->>'updated'$q$)),
 ('A사장','  └ 켜짐 + 91000','true|91000', pg_temp.val($q$select is_active||'|'||base_price::int from public.products where id='c3999999-0000-0000-0000-000000000003'$q$));
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','개별가격 끄기 → 1행','1', pg_temp.rows($q$update public.custom_prices set is_active=false where id='f3999999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원','개별가격 켜기 → 0행','0', pg_temp.rows($q$update public.custom_prices set is_active=true where id='f3999999-0000-0000-0000-000000000001'$q$)),
 ('A직원','개별가격 등록 → 거부','DENIED', pg_temp.try($q$insert into public.custom_prices (wholesaler_id,organization_id,retailer_id,product_id,custom_price,is_active) values ('a3999999-0000-0000-0000-000000000001','03999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','c3999999-0000-0000-0000-000000000003',1,true)$q$)),
 ('A직원','개별가격 조회는 됨(직원도 단가 보고 응대)','1', pg_temp.val($q$select count(*)::text from public.custom_prices where id='f3999999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('B사장','A사의 일괄변경이 B사 상품을 못 건드림 → 20000 그대로','20000', pg_temp.val($q$select base_price::int::text from public.products where id='c3999999-0000-0000-0000-000000000002'$q$)),
 ('B사장','A사 개별가격 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.custom_prices where id='f3999999-0000-0000-0000-000000000001'$q$)),
 ('B사장','A사 개별가격 수정 → 0행','0', pg_temp.rows($q$update public.custom_prices set custom_price=1 where id='f3999999-0000-0000-0000-000000000001'$q$));
-- 꺼진 개별가격은 주문에 못 쓴다(103 트리거) → 기준가만
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','자기 개별가격 행 조회 → 1건(꺼져 있어도 행은 보임)','1', pg_temp.val($q$select count(*)::text from public.custom_prices where id='f3999999-0000-0000-0000-000000000001'$q$)),
 ('식당R','주문 헤더','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e3999999-0000-0000-0000-000000000002','a3999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','PROD-2',32000,'pending','서울')$q$)),
 ('식당R','꺼진 개별가격(25000)으로 품목 → 거부','DENIED: PRICE_MISMATCH', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e3999999-0000-0000-0000-000000000002','c3999999-0000-0000-0000-000000000006','P6',25000,1,25000)$q$)),
 ('식당R','기준가(32000)로 품목 → 허용','ALLOWED', pg_temp.try($q$insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e3999999-0000-0000-0000-000000000002','c3999999-0000-0000-0000-000000000006','P6',32000,1,32000)$q$)),
 ('식당R','보관된 상품(P1) 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.products where id='c3999999-0000-0000-0000-000000000001'$q$)),
 ('식당R','보관된 상품 주문 품목 → 거부','DENIED: PRODUCT_NOT_ORDERABLE', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e3999999-0000-0000-0000-000000000003','a3999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','PROD-3',68000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e3999999-0000-0000-0000-000000000003','c3999999-0000-0000-0000-000000000001','P1',68000,1,68000)$q$));
-- 다시 켜면 개별가격이 적용된다
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','개별가격 다시 켜기 → 1행','1', pg_temp.rows($q$update public.custom_prices set is_active=true where id='f3999999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','켜진 뒤 기준가(32000)로 품목 → 거부','DENIED: PRICE_MISMATCH', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e3999999-0000-0000-0000-000000000004','a3999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','PROD-4',32000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e3999999-0000-0000-0000-000000000004','c3999999-0000-0000-0000-000000000006','P6',32000,1,32000)$q$)),
 ('식당R','켜진 뒤 개별가격(25000)으로 품목 → 허용','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e3999999-0000-0000-0000-000000000005','a3999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','PROD-5',25000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e3999999-0000-0000-0000-000000000005','c3999999-0000-0000-0000-000000000006','P6',25000,1,25000)$q$));

-- ========== 2-E. 발주정지 (재고 0 자동정지 / 재입고돼도 유지 / 수동 재개) ==========
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','P6 재고를 0으로 조정 → 자동 발주정지(out_of_stock)','true|out_of_stock', pg_temp.val($q$select (select public.adjust_product_stock('c3999999-0000-0000-0000-000000000006', 0, 'STOCKTAKE', '실사')) is not null and true, null; select order_stopped||'|'||order_stopped_reason from public.products where id='c3999999-0000-0000-0000-000000000006'$q$)),
 ('A사장','재입고(재고 5) → 정지 유지(자동 해제 없음, 잠긴 결정 3)','true|out_of_stock|5', pg_temp.val($q$select (select public.adjust_product_stock('c3999999-0000-0000-0000-000000000006', 5, 'STOCKTAKE', '재입고')) is not null and true, null; select order_stopped||'|'||order_stopped_reason||'|'||stock_quantity::int from public.products where id='c3999999-0000-0000-0000-000000000006'$q$));
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','발주정지 상품 주문 품목 → 거부(재고 있어도)','DENIED: PRODUCT_NOT_ORDERABLE', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e3999999-0000-0000-0000-000000000006','a3999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','PROD-6',25000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e3999999-0000-0000-0000-000000000006','c3999999-0000-0000-0000-000000000006','P6',25000,1,25000)$q$));
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','수동 재개 → 1행','1', pg_temp.rows($q$update public.products set order_stopped=false, order_stopped_reason=null, order_stopped_at=null where id='c3999999-0000-0000-0000-000000000006'$q$)),
 ('A사장','재고 남은 채 수동 정지 → 1행','1', pg_temp.rows($q$update public.products set order_stopped=true, order_stopped_reason='manual', order_stopped_at=now() where id='c3999999-0000-0000-0000-000000000006'$q$)),
 ('A사장','재고 조정(5→4)해도 수동 정지 사유 유지','true|manual', pg_temp.val($q$select (select public.adjust_product_stock('c3999999-0000-0000-0000-000000000006', 4, 'STOCKTAKE', '실사')) is not null and true, null; select order_stopped||'|'||order_stopped_reason from public.products where id='c3999999-0000-0000-0000-000000000006'$q$)),
 ('A사장','잘못된 정지 사유 값 → 거부(CHECK)','DENIED', pg_temp.try($q$update public.products set order_stopped_reason='whatever' where id='c3999999-0000-0000-0000-000000000006'$q$));
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','수동 정지 상품 주문 품목 → 거부','DENIED: PRODUCT_NOT_ORDERABLE', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e3999999-0000-0000-0000-000000000007','a3999999-0000-0000-0000-000000000001','d3999999-0000-0000-0000-000000000001','PROD-7',25000,'pending','서울'); insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values ('e3999999-0000-0000-0000-000000000007','c3999999-0000-0000-0000-000000000006','P6',25000,1,25000)$q$));

reset role;
select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
