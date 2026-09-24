-- 6. 서류발행 통합테스트 — DB 레벨(계산서 발행이력 tax_invoice_issuances의 권한·제약·연쇄)
--    팝빌 API 호출, PDF 생성, 사업장 주소 미등록 차단(순수 함수, statement.test.ts)은 여기서 다루지 않는다.
--
-- 표시: "[발견]"·"[정보]"는 지금 DB가 그렇게 동작한다는 관찰(기대값 = 현재 동작). 고치면 기대값을 바꾼다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-documents.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
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

-- ========== 시드 (접두어 92) ==========
insert into auth.users (id,email) values
 ('92999999-0000-0000-0000-000000000001','owner-a@doc.test'),
 ('92999999-0000-0000-0000-000000000002','manager-a@doc.test'),
 ('92999999-0000-0000-0000-000000000003','staff-a@doc.test'),
 ('92999999-0000-0000-0000-000000000004','retailer-r@doc.test'),
 ('92999999-0000-0000-0000-000000000005','owner-b@doc.test'),
 ('92999999-0000-0000-0000-000000000006','super@doc.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('92999999-0000-0000-0000-000000000001','wholesaler','A사장','010',true,true),
 ('92999999-0000-0000-0000-000000000002','wholesaler','A매니저','010',true,true),
 ('92999999-0000-0000-0000-000000000003','wholesaler','A직원','010',true,true),
 ('92999999-0000-0000-0000-000000000004','retailer','식당R','010',false,false),
 ('92999999-0000-0000-0000-000000000005','wholesaler','B사장','010',true,true),
 ('92999999-0000-0000-0000-000000000006','super_admin','관리자','010',false,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,min_order_amount) values
 ('a2999999-0000-0000-0000-000000000001','92999999-0000-0000-0000-000000000001','A축산','9290000001','A','active',0),
 ('a2999999-0000-0000-0000-000000000002','92999999-0000-0000-0000-000000000005','B축산','9290000002','B','active',0);
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('02999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','A축산','9290000001'),
 ('02999999-0000-0000-0000-000000000002','a2999999-0000-0000-0000-000000000002','B축산','9290000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('02999999-0000-0000-0000-000000000001','92999999-0000-0000-0000-000000000001','owner'),
 ('02999999-0000-0000-0000-000000000001','92999999-0000-0000-0000-000000000002','manager'),
 ('02999999-0000-0000-0000-000000000001','92999999-0000-0000-0000-000000000003','staff'),
 ('02999999-0000-0000-0000-000000000002','92999999-0000-0000-0000-000000000005','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d2999999-0000-0000-0000-000000000001','92999999-0000-0000-0000-000000000004','식당R','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status) values
 ('a2999999-0000-0000-0000-000000000001','d2999999-0000-0000-0000-000000000001','active');
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values
 ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','d2999999-0000-0000-0000-000000000001','DOC-1',50000,'delivered','서울'),
 ('e2999999-0000-0000-0000-000000000004','a2999999-0000-0000-0000-000000000001','d2999999-0000-0000-0000-000000000001','DOC-4',60000,'delivered','서울'),
 ('e2999999-0000-0000-0000-000000000005','a2999999-0000-0000-0000-000000000001','d2999999-0000-0000-0000-000000000001','DOC-5',70000,'delivered','서울');

-- ========== 6-A. 공급사 사장(A) — 정상·제약 ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '92999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','발행이력(pending) 등록 → 허용, 작성자 자동 기록','ALLOWED|true', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k1','pending')$q$)||'|'||pg_temp.val($q$select (created_by = '92999999-0000-0000-0000-000000000001')::text from public.tax_invoice_issuances where popbill_mgt_key='k1'$q$)),
 ('A사장','과세 유형 → 거부(면세 고정 CHECK)','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,tax_type) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','kx1','과세')$q$)),
 ('A사장','정정 사유 0·7 → 거부(1~6 CHECK)','DENIED|DENIED', left(pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,modify_code) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','kx2',0)$q$),6)||'|'||left(pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,modify_code) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','kx3',7)$q$),6)),
 ('A사장','정해지지 않은 상태값 → 거부(CHECK)','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','kx4','weird')$q$)),
 ('A사장','같은 문서관리번호 두 번 → 거부(공급사별 유니크)','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k1','pending')$q$)),
 ('A사장','같은 주문에 살아 있는(pending) 최초 발행이력이 있는데 또 최초 발행 시도 → 거부(109, 이중 접수 방지)','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status,issued_at) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k2','issued',now())$q$)),
 ('A사장','첫 시도가 실패(failed)로 끝나면 다시 발행 가능 → 실패 처리 1행 후 issued 등록 허용','1|ALLOWED', pg_temp.rows($q$update public.tax_invoice_issuances set status='failed', error_message='수기' where popbill_mgt_key='k1'$q$)||'|'||pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status,issued_at) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k2','issued',now())$q$)),
 ('A사장','발행 완료(issued)된 주문에 또 최초 발행(버튼 두 번) → 거부','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k2dup','pending')$q$)),
 ('A사장','취소(cancelled) 처리된 이력은 살아 있는 것으로 세지 않음 → 허용','ALLOWED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k3','cancelled')$q$)),
 ('A사장','정정 행(원본 k2 연결, 사유 3) → 허용','ALLOWED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status,modify_code,original_issuance_id) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k4','pending',3,(select id from public.tax_invoice_issuances where popbill_mgt_key='k2'))$q$)),
 ('A사장','[정보] 정정 행에 사유 없음·사유는 있는데 원본 없음 → DB 연결 규칙 없음(앱 타입으로만 강제)','ALLOWED|ALLOWED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status,original_issuance_id) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k5','pending',(select id from public.tax_invoice_issuances where popbill_mgt_key='k2'))$q$)||'|'||pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status,modify_code) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k6','pending',1)$q$)),
 ('A사장','[정보] 사장이 자기 발행이력의 상태·국세청 승인번호를 직접 수정 → 1행(서버 흐름도 같은 권한으로 갱신)','1', pg_temp.rows($q$update public.tax_invoice_issuances set error_message='수기 메모' where popbill_mgt_key='k1'$q$)),
 ('A사장','정정 행은 원본당 여러 건 가능(k2에 두 번째 정정) → 허용','ALLOWED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status,modify_code,original_issuance_id) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k4b','pending',2,(select id from public.tax_invoice_issuances where popbill_mgt_key='k2'))$q$)),
 ('A사장','[정보] 사장이 발행이력 행을 직접 삭제 → 1행(국세청 접수 기록도 지울 수 있음)','1', pg_temp.rows($q$delete from public.tax_invoice_issuances where popbill_mgt_key='k5'$q$)),
 ('A사장','원본(k2) 삭제 → 그 정정 행(k4)의 원본 연결만 끊김','1|<null>', pg_temp.rows($q$delete from public.tax_invoice_issuances where popbill_mgt_key='k2'$q$)||'|'||pg_temp.val($q$select original_issuance_id::text from public.tax_invoice_issuances where popbill_mgt_key='k4'$q$)),
 ('A사장','다른 주문(DOC-4)의 최초 발행은 별개로 허용','ALLOWED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000004','a2999999-0000-0000-0000-000000000001','k10','pending')$q$)),
 ('A사장','남은 발행이력 조회 6건(k1·k3·k4·k4b·k6·k10)','6', pg_temp.val($q$select count(*)::text from public.tax_invoice_issuances$q$));

-- ========== 6-B. 매니저·직원 — 앱은 owner/manager만 발행 허용 ==========
set request.jwt.claim.sub = '92999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','매니저의 발행이력 생성 → 허용(109, 앱 owner/manager 발행 허용과 일치)','ALLOWED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000005','a2999999-0000-0000-0000-000000000001','k7','pending')$q$)),
 ('A매니저','매니저도 같은 주문 중복 발행은 거부','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000005','a2999999-0000-0000-0000-000000000001','k7dup','pending')$q$)),
 ('A매니저','매니저는 회사 발행이력 조회 가능 → 7건','7', pg_temp.val($q$select count(*)::text from public.tax_invoice_issuances$q$)),
 ('A매니저','매니저가 타사 명의로 발행이력 생성 → 거부','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000005','a2999999-0000-0000-0000-000000000002','k7b','pending')$q$));
set request.jwt.claim.sub = '92999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원','직원의 발행이력 생성 → 거부','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k8','pending')$q$)),
 ('A직원','직원의 발행이력 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.tax_invoice_issuances$q$));

-- ========== 6-C. 타사·고객·비로그인 ==========
set request.jwt.claim.sub = '92999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('B사장','A사 발행이력 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.tax_invoice_issuances where wholesaler_id='a2999999-0000-0000-0000-000000000001'$q$)),
 ('B사장','A사 명의로 발행이력 생성 → 거부','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','k9','pending')$q$)),
 ('B사장','A사 발행이력 수정·삭제 → 0행','0|0', pg_temp.rows($q$update public.tax_invoice_issuances set status='cancelled' where popbill_mgt_key='k3'$q$)||'|'||pg_temp.rows($q$delete from public.tax_invoice_issuances where popbill_mgt_key='k3'$q$)),
 ('B사장','[정보] 자기 명의로 A사 주문 ID에 발행이력 연결 → DB가 주문 소속을 안 봄(주문 ID를 알아야 하고 A 화면에는 안 보임)','ALLOWED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000002','kb1','pending')$q$)),
 ('B사장','[정보] A사 발행이력을 원본으로 하는 정정 행 → FK만 봐서 허용','ALLOWED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status,modify_code,original_issuance_id) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000002','kb2','pending',1,(select id from public.tax_invoice_issuances where popbill_mgt_key='k3' and wholesaler_id='a2999999-0000-0000-0000-000000000001'))$q$));
set request.jwt.claim.sub = '92999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','고객 계정 발행이력 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.tax_invoice_issuances$q$)),
 ('식당R','고객 계정 발행이력 생성 → 거부','DENIED', pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','kr1','pending')$q$));
set role anon; set request.jwt.claim.role = 'anon'; set request.jwt.claim.sub = '';
insert into results (who,what,expected,result) values
 ('비로그인','발행이력 조회 0건·생성 거부','0|DENIED', pg_temp.val($q$select count(*)::text from public.tax_invoice_issuances$q$)||'|'||left(pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','kn1','pending')$q$),6));
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '92999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('관리자','관리자는 전체 발행이력 조회 → 9건(A 7 + B 2)','9', pg_temp.val($q$select count(*)::text from public.tax_invoice_issuances$q$)),
 ('관리자','[정보] 관리자 세션의 직접 생성·수정은 정책상 거부(조회 전용)','DENIED|DENIED', left(pg_temp.try($q$insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status) values ('e2999999-0000-0000-0000-000000000001','a2999999-0000-0000-0000-000000000001','ks1','pending')$q$),6)||'|'||left(pg_temp.try($q$update public.tax_invoice_issuances set status='cancelled' where popbill_mgt_key='k3'$q$),6));

-- ========== 6-D. 주문 금액 제약·삭제 연쇄 (서버/관리 권한) ==========
reset role;
insert into results (who,what,expected,result) values
 ('서버','주문 총액 음수 → 거부(CHECK) — 음수 금액 계산서는 애초에 못 만든다','DENIED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e2999999-0000-0000-0000-000000000002','a2999999-0000-0000-0000-000000000001','d2999999-0000-0000-0000-000000000001','DOC-NEG',-1,'pending','서울')$q$)),
 ('서버','[정보] 총액 0원 주문은 허용 — 계산서 발행 코드에 0원 거부 검사가 없음(코드 확인)','ALLOWED', pg_temp.try($q$insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('e2999999-0000-0000-0000-000000000003','a2999999-0000-0000-0000-000000000001','d2999999-0000-0000-0000-000000000001','DOC-ZERO',0,'delivered','서울')$q$)),
 ('서버','주문 삭제 전 그 주문의 발행이력 7건(A 5 + B 2)','7', pg_temp.val($q$select count(*)::text from public.tax_invoice_issuances where order_id='e2999999-0000-0000-0000-000000000001'$q$)),
 ('서버','주문 삭제 → 1행','1', pg_temp.rows($q$delete from public.orders where id='e2999999-0000-0000-0000-000000000001'$q$));
insert into results (who,what,expected,result) values
 ('서버','  └ 발행이력이 전부 연쇄 삭제됨(7 → 0) — 주문 삭제는 서버 권한뿐이라 실사용에선 발생하지 않음','0', pg_temp.val($q$select count(*)::text from public.tax_invoice_issuances where order_id='e2999999-0000-0000-0000-000000000001'$q$));

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
