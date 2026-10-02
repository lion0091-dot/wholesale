-- 비로그인(anon) 공개 표면 점검(마이그 202). 로컬 Docker DB 전용, 전부 롤백. 실행:
--   (echo "begin;"; cat scripts/db-test-anon-surface.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- 1) anon이 실행할 수 있는 public 함수는 허용 목록(정책이 참조하는 14개 + 공개 페이지용 2개)뿐이어야 한다 — 새 함수를 만든 마이그레이션이 `revoke execute ... from public, anon`을 빠뜨리면 여기서 실패한다. 비로그인이 정말 써야 하면 사유와 함께 이 목록에 추가한다.
-- 2) 비로그인이 실제로 해야 하는 일(공개 페이지 조회·입점 문의 등록)은 여전히 된다(과차단 아님).
-- 3) 비로그인은 데이터 변경 함수를 호출조차 못 한다(권한 오류). 서버 전용 함수는 로그인 사용자도 못 부른다.
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then raise exception 'FAIL: %', p_name; end if;
    raise notice 'PASS: %', p_name;
end $$;

-- SQL을 anon(또는 authenticated) 역할로 실행해 SQLSTATE를 돌려준다. 성공이면 '00000'.
create or replace function pg_temp.sqlstate_as(p_role text, p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v_state text := '00000';
begin
    perform set_config('request.jwt.claims', case when p_sub is null then '{"role":"anon"}' else json_build_object('sub', p_sub, 'role', 'authenticated')::text end, true);
    execute format('set local role %I', p_role);
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate;
    end;
    execute 'reset role';
    return v_state;
end $$;

-- ───────────── 1) 허용 목록 대조 ─────────────
do $$
declare
    v_allow constant text[] := array[
        'can_access_wholesaler', 'can_access_wholesaler_folder', 'can_manage_wholesaler', 'can_manage_wholesaler_folder',
        'can_manage_wholesaler_thumbnail', 'get_current_organization_id', 'get_current_retailer_id', 'get_current_role',
        'get_current_wholesaler_id', 'has_organization_role', 'is_org_staff_of_wholesaler', 'is_organization_member',
        'organization_has_no_staff', 'resolve_current_wholesaler_id',
        'get_public_shop_identity', 'get_staff_invite_info'
    ];
    v_extra text;
begin
    select string_agg(p.proname, ', ' order by p.proname) into v_extra
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
       and has_function_privilege('anon', p.oid, 'execute')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and not (p.proname = any (v_allow));

    perform pg_temp.expect('비로그인이 실행할 수 있는 함수는 허용 목록뿐이다 (초과: ' || coalesce(v_extra, '없음') || ')', v_extra is null);
end $$;

-- 트리거 함수는 아무도 직접 못 부른다
select pg_temp.expect('트리거 함수는 anon·authenticated가 직접 실행할 수 없다',
    not exists (
        select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
           and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
           and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));

-- ───────────── 2) 공개 표면은 그대로 동작 ─────────────
select pg_temp.expect('anon: 공개 미니샵 입구 함수 호출이 된다',
    pg_temp.sqlstate_as('anon', null, $q$select public.get_public_shop_identity('00000000-0000-0000-0000-000000000000')$q$) = '00000');
select pg_temp.expect('anon: 직원 초대 정보 함수 호출이 된다',
    pg_temp.sqlstate_as('anon', null, $q$select public.get_staff_invite_info('00000000-0000-0000-0000-000000000000')$q$) = '00000');
select pg_temp.expect('anon: 정책이 참조하는 함수 때문에 표 조회가 권한 오류로 깨지지 않는다(products·orders·wholesalers·stock_ledger·inbound_scans)',
    pg_temp.sqlstate_as('anon', null, 'select count(*) from public.products') = '00000'
    and pg_temp.sqlstate_as('anon', null, 'select count(*) from public.orders') = '00000'
    and pg_temp.sqlstate_as('anon', null, 'select count(*) from public.wholesalers') = '00000'
    and pg_temp.sqlstate_as('anon', null, 'select count(*) from public.stock_ledger') = '00000'
    and pg_temp.sqlstate_as('anon', null, 'select count(*) from public.inbound_scans') = '00000');
select pg_temp.expect('anon: 입점 문의(리드) 등록은 된다',
    pg_temp.sqlstate_as('anon', null, $q$insert into public.retailer_match_requests (restaurant_name, contact_name, contact_phone) values ('식당', '담당', '01000000000')$q$) = '00000');
select pg_temp.expect('anon: 입점 문의 목록은 못 읽는다(방금 넣은 행이 안 보임)',
    (select count(*) from public.retailer_match_requests) >= 1
    and pg_temp.sqlstate_as('anon', null, $q$do $x$ begin if (select count(*) from public.retailer_match_requests) > 0 then raise exception 'LEAK'; end if; end $x$$q$) = '00000');

-- ───────────── 3) 비로그인은 변경 함수를 호출조차 못 한다(42501 = 권한 없음) ─────────────
select pg_temp.expect('anon: 재고 조정 함수 호출 거부', pg_temp.sqlstate_as('anon', null, $q$select public.adjust_product_stock(gen_random_uuid(), 1, 'x', 'x')$q$) = '42501');
select pg_temp.expect('anon: 출고 마감 함수 호출 거부', pg_temp.sqlstate_as('anon', null, $q$select public.finalize_order_shipment(gen_random_uuid(), false)$q$) = '42501');
select pg_temp.expect('anon: 외상 정산 함수 호출 거부', pg_temp.sqlstate_as('anon', null, $q$select public.settle_credit_orders(array[gen_random_uuid()])$q$) = '42501');
select pg_temp.expect('anon: 재고 보기 집계 함수 호출 거부(195·192에서 다시 만든 함수)', pg_temp.sqlstate_as('anon', null, $q$select * from public.shadow_box_stock(gen_random_uuid())$q$) = '42501');
select pg_temp.expect('anon: 입출고 내역 요약 함수 호출 거부(195에서 다시 만든 함수)', pg_temp.sqlstate_as('anon', null, $q$select * from public.summarize_stock_ledger(gen_random_uuid())$q$) = '42501');
select pg_temp.expect('anon: 계정 탈퇴 함수 호출 거부', pg_temp.sqlstate_as('anon', null, $q$select public.withdraw_wholesaler_account()$q$) = '42501');

-- 서버 전용 함수는 로그인 사용자도 못 부른다(권한 보존 확인)
insert into auth.users (id, email) values ('d9000000-0000-0000-0000-000000000001', 'surface@t.com');
select pg_temp.expect('로그인 사용자: 서버 전용 점검 함수 호출 거부(권한이 다시 열리지 않았다)',
    pg_temp.sqlstate_as('authenticated', 'd9000000-0000-0000-0000-000000000001', 'select * from public.tenant_consistency_violations()') = '42501');
select pg_temp.expect('로그인 사용자: 관리자 승격 함수 호출 거부',
    pg_temp.sqlstate_as('authenticated', 'd9000000-0000-0000-0000-000000000001', $q$select public.grant_platform_admin(gen_random_uuid(), gen_random_uuid(), false, 'x')$q$) = '42501');
select pg_temp.expect('로그인 사용자: 일반 업무 함수는 호출된다(권한 오류가 아니다)',
    pg_temp.sqlstate_as('authenticated', 'd9000000-0000-0000-0000-000000000001', $q$select * from public.shadow_box_stock(gen_random_uuid())$q$) <> '42501');
