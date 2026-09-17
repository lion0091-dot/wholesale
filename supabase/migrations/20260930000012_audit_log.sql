-- 범용 변경 이력(감사 로그) — 여신(wholesaler_retailers)부터 시작해 여러 테이블에
-- 붙일 예정. created_by/updated_by(20260930000008~10)는 "마지막으로 누가 바꿨는지"만
-- 남기지만, 이건 매 변경마다 이전/이후 값을 통째로 남겨 진짜 히스토리를 추적한다.
--
-- 테이블마다 별도 로그 테이블을 만들지 않고 하나로 통합한다 — 조회 화면을 만들 때도
-- table_name/row_id로 한 군데만 보면 된다.
create table public.audit_log (
    id         bigint generated always as identity primary key,
    table_name text not null,
    row_id     uuid not null,
    action     text not null check (action in ('insert', 'update', 'delete')),
    changed_by uuid references auth.users(id) on delete set null,
    old_data   jsonb,
    new_data   jsonb,
    created_at timestamptz not null default now()
);

create index idx_audit_log_table_row on public.audit_log(table_name, row_id, created_at desc);

alter table public.audit_log enable row level security;

-- 지금은 조회 화면이 없어서 super_admin만 허용해둔다. 실제 조회 화면(6단계)을
-- 만들 때 테이블별로 "그 행에 접근 권한 있는 사용자"를 판정하는 스코프 RPC를
-- 따로 만들 것 — audit_log 테이블 자체를 직접 SELECT하게 열어주지 않는다
-- (여러 테이블이 섞여 있어 행 단위 소유권 판정이 테이블마다 다르기 때문).
create policy "Audit log viewable by super admin" on public.audit_log
    for select
    using (public.get_current_role() = 'super_admin');

-- 기록은 트리거(SECURITY DEFINER)로만 일어나므로 authenticated에 INSERT 권한을
-- 별도로 주지 않는다 — 클라이언트가 직접 이 테이블에 쓰는 경로를 원천 차단한다.

create or replace function public.log_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.audit_log (table_name, row_id, action, changed_by, old_data, new_data)
    values (
        TG_TABLE_NAME,
        case when TG_OP = 'DELETE' then OLD.id else NEW.id end,
        lower(TG_OP),
        auth.uid(),
        case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(OLD) else null end,
        case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(NEW) else null end
    );

    if TG_OP = 'DELETE' then
        return OLD;
    end if;

    return NEW;
end;
$$;
