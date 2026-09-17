-- 미니샵 썸네일(업체 대표 사진/로고) 업로드용 public 버킷.
--
-- 사업자등록증(private, business-licenses)과 달리 이건 고객에게 그대로 보여줄
-- 목적의 사진이라 민감정보가 아니다 — public 버킷으로 만들어 서명된 URL 없이
-- 바로 표시한다. 상품/가격 테이블과는 완전히 무관하다(가격 노출 가능성 자체가
-- 구조적으로 없음 — /my-shops 카드에 업체 사진 하나만 얹는 용도).
insert into storage.buckets (id, name, public)
values ('shop-thumbnails', 'shop-thumbnails', true)
on conflict (id) do nothing;

-- 대표 본인(wholesalers.profile_id) 또는 조직의 owner/manager 직원만 해당
-- 업체 폴더(<wholesaler_id>/...)에 쓸 수 있다. 일반 staff 직원은 브랜딩 변경 불가.
create or replace function public.can_manage_wholesaler_thumbnail(p_wholesaler_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select
        exists (
            select 1 from public.wholesalers w
             where w.id = p_wholesaler_id
               and w.profile_id = auth.uid()
        )
        or exists (
            select 1 from public.organizations o
            join public.organization_staff s on s.organization_id = o.id
            where o.wholesaler_id = p_wholesaler_id
              and s.user_id = auth.uid()
              and s.role = any(array['owner', 'manager']::public.organization_role[])
        )
        or public.get_current_role() = 'super_admin';
$$;

create policy "Shop thumbnail insert by wholesaler staff"
on storage.objects for insert
to authenticated
with check (
    bucket_id = 'shop-thumbnails'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
);

create policy "Shop thumbnail update by wholesaler staff"
on storage.objects for update
to authenticated
using (
    bucket_id = 'shop-thumbnails'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
)
with check (
    bucket_id = 'shop-thumbnails'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
);

create policy "Shop thumbnail delete by wholesaler staff"
on storage.objects for delete
to authenticated
using (
    bucket_id = 'shop-thumbnails'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
);

-- public 버킷은 storage.objects SELECT RLS와 무관하게 공개 URL로 바로 읽히므로
-- SELECT 정책은 필요 없다.

alter table public.wholesalers
    add column shop_thumbnail_url text;

comment on column public.wholesalers.shop_thumbnail_url is
    '미니샵 썸네일(업체 사진/로고) 공개 URL. null이면 미등록 — /my-shops 등에서 기본 아이콘으로 대체 표시.';
