-- 184: 상품 사진 — 미니샵 카드에 상품별 사진을 보여준다 (사장님 요청)
--
-- products.image_url  : 공개 URL(재업로드 시 ?v= 로 캐시 무효화). null이면 사진 없음 → 카드는 지금처럼 사진 없이 표시.
-- product-images 버킷 : public. 상품 사진은 고객에게 그대로 보여줄 자료라 민감정보가 아니고 가격 정보도 담지 않는다.
--                       경로 = <wholesaler_id>/<product_id> — 쓰기 권한은 미니샵 썸네일과 같은 판정
--                       (can_manage_wholesaler_thumbnail: 대표 본인, 조직 owner/manager, super_admin)을 재사용한다.
--                       상품 관리 권한(owner/manager)과 같은 범위다.

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "Product image insert by wholesaler staff" on storage.objects;
create policy "Product image insert by wholesaler staff"
on storage.objects for insert
to authenticated
with check (
    bucket_id = 'product-images'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "Product image update by wholesaler staff" on storage.objects;
create policy "Product image update by wholesaler staff"
on storage.objects for update
to authenticated
using (
    bucket_id = 'product-images'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
)
with check (
    bucket_id = 'product-images'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "Product image delete by wholesaler staff" on storage.objects;
create policy "Product image delete by wholesaler staff"
on storage.objects for delete
to authenticated
using (
    bucket_id = 'product-images'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
);

alter table public.products
    add column if not exists image_url text;

comment on column public.products.image_url is
    '상품 사진 공개 URL(product-images 버킷). null이면 사진 없음 — 미니샵 카드는 사진 없이 표시.';
