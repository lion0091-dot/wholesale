-- 202: 비로그인(anon)이 실행할 수 있는 public 함수를 필요한 것만 남긴다 (2026-10-02 격리 점검).
-- 발견: PostgreSQL은 새 함수를 PUBLIC(=anon 포함)에 실행 허용으로 만든다. 그래서 재고 조정·출고 마감·외상 정산·탈퇴 같은 데이터 변경 DB 함수
--       약 100개를 비로그인이 호출할 수 있었다. 지금은 각 함수 안의 권한 검사가 비로그인을 거절해 막혀 있지만, 검사 하나가 틀리면 바로 뚫리는 구조다
--       (097의 NULL 비교 버그가 그런 사례). 195·192에서 다시 만든 함수들(summarize_stock_ledger, shadow_box_stock 등)도 같은 상태였다.
-- 조치: anon에 남기는 것은 (a) RLS 정책·Storage 정책이 참조하는 함수(비로그인 조회도 정책을 평가하므로 필요) 14개,
--       (b) 로그인 전 공개 페이지가 쓰는 get_public_shop_identity·get_staff_invite_info 2개뿐이다.
--       나머지는 PUBLIC·anon 회수. 로그인 사용자(authenticated)·service_role의 기존 권한은 함수별로 현재 상태를 읽어 그대로 보존한다
--       (서버 전용으로 이미 막아 둔 함수가 다시 열리면 안 되므로 "전부 부여"가 아니라 "있던 것만 명시 부여").
--       트리거 함수는 직접 호출될 일이 없으므로 PUBLIC·anon·authenticated 모두 회수한다(기존 규칙).
-- 새 함수 규칙: PostgreSQL의 기본값(새 함수는 PUBLIC 실행 허용)은 스키마 한정 default privileges로 바꿀 수 없고, 전역 기본값을 바꾸면 다른 스키마·확장에도
--       영향을 주므로 건드리지 않는다. 대신 새 함수를 만드는 마이그레이션에서 `revoke execute ... from public, anon`(+필요한 역할에 grant)을 직접 쓰고,
--       어기면 scripts/db-test-anon-surface.sql(허용 목록 대조)이 tenant-isolation.itest.ts에서 실패한다.

do $$
declare
    r record;
    v_allow constant text[] := array[
        -- RLS·Storage 정책이 참조(비로그인 조회에서도 평가됨)
        'can_access_wholesaler', 'can_access_wholesaler_folder', 'can_manage_wholesaler', 'can_manage_wholesaler_folder',
        'can_manage_wholesaler_thumbnail', 'get_current_organization_id', 'get_current_retailer_id', 'get_current_role',
        'get_current_wholesaler_id', 'has_organization_role', 'is_org_staff_of_wholesaler', 'is_organization_member',
        'organization_has_no_staff', 'resolve_current_wholesaler_id',
        -- 로그인 전 공개 페이지(미니샵 입구, 직원 초대 링크)
        'get_public_shop_identity', 'get_staff_invite_info'
    ];
    v_auth boolean;
    v_svc  boolean;
    v_revoked integer := 0;
begin
    for r in
        select p.oid, p.proname, p.prorettype
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.prokind in ('f', 'p')
           -- 확장이 만든 함수(pg_trgm 등)는 건드리지 않는다.
           and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    loop
        v_auth := has_function_privilege('authenticated', r.oid, 'execute');
        v_svc  := has_function_privilege('service_role', r.oid, 'execute');

        if r.prorettype = 'trigger'::regtype then
            execute format('revoke all on function %s from public, anon, authenticated', r.oid::regprocedure);
            v_revoked := v_revoked + 1;
            continue;
        end if;

        -- 지금 갖고 있는 권한만 명시 부여(PUBLIC 경유로 받던 것을 직접 부여로 바꾼다)
        if v_auth then execute format('grant execute on function %s to authenticated', r.oid::regprocedure); end if;
        if v_svc  then execute format('grant execute on function %s to service_role', r.oid::regprocedure); end if;

        if r.proname = any (v_allow) then
            execute format('grant execute on function %s to anon', r.oid::regprocedure);
            execute format('revoke execute on function %s from public', r.oid::regprocedure);
        else
            if has_function_privilege('anon', r.oid, 'execute') then v_revoked := v_revoked + 1; end if;
            execute format('revoke execute on function %s from public, anon', r.oid::regprocedure);
        end if;
    end loop;

    raise notice '202: anon 실행 권한 회수 함수 % 개', v_revoked;
end $$;
