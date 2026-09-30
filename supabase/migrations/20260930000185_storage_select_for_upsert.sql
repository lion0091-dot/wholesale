-- 185: 상품 사진(product-images)·미니샵 썸네일(shop-thumbnails) 재업로드/삭제가 RLS에 막히던 문제
--
-- 두 버킷은 public이라 읽기(공개 URL)에는 SELECT 정책이 필요 없지만, 이미 있는 파일을 덮어쓰는 upsert(ON CONFLICT DO UPDATE)와
-- 삭제는 기존 행을 SELECT로 볼 수 있어야 통과한다. SELECT 정책이 없어 "사진 바꾸기"가 RLS 위반으로 실패하고
-- 삭제는 0행이라 파일이 남았다(로컬 DB에서 재현). 쓰기 권한과 같은 판정으로 SELECT만 열어 준다.
-- 공개 URL 읽기에는 영향이 없다(public 버킷).

drop policy if exists "Product image select by wholesaler staff" on storage.objects;
create policy "Product image select by wholesaler staff"
on storage.objects for select
to authenticated
using (
    bucket_id = 'product-images'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "Shop thumbnail select by wholesaler staff" on storage.objects;
create policy "Shop thumbnail select by wholesaler staff"
on storage.objects for select
to authenticated
using (
    bucket_id = 'shop-thumbnails'
    and public.can_manage_wholesaler_thumbnail(((storage.foldername(name))[1])::uuid)
);
