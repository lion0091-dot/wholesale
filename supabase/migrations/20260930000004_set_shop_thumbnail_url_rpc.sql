-- wholesalers UPDATE RLS("Wholesalers updatable by self or admin")는 profile_id = auth.uid()만
-- 허용해서, 1단계(20260930000003)에서 Storage 업로드는 허용한 조직 owner/manager 직원이
-- wholesalers.shop_thumbnail_url 저장 단계에서 막힌다. 같은 권한 판정
-- (can_manage_wholesaler_thumbnail)을 재사용하는 RPC로 그 저장 단계만 우회 허용한다.
create or replace function public.set_shop_thumbnail_url(
    p_wholesaler_id uuid,
    p_url           text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.can_manage_wholesaler_thumbnail(p_wholesaler_id) then
        raise exception 'NOT_AUTHORIZED_FOR_THUMBNAIL';
    end if;

    update public.wholesalers
       set shop_thumbnail_url = p_url,
           updated_at = now()
     where id = p_wholesaler_id;

    if not found then
        raise exception 'WHOLESALER_NOT_FOUND';
    end if;

    return jsonb_build_object('wholesaler_id', p_wholesaler_id, 'shop_thumbnail_url', p_url);
end;
$$;

revoke all on function public.set_shop_thumbnail_url(uuid, text) from public;
grant execute on function public.set_shop_thumbnail_url(uuid, text) to authenticated;
