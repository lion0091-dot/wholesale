-- 186: 상품 사진·썸네일 저장소 정책의 uuid 형변환을 안전하게 (코드리뷰 지적)
--
-- 184·185 정책은 (storage.foldername(name))[1]::uuid 를 곧바로 쓴다. SELECT 정책은 인증된 사용자의 storage.objects 읽기 전부에서
-- 평가되는데, Postgres는 'bucket_id = ...' 가 형변환보다 먼저 평가된다고 보장하지 않는다. 다른 버킷 파일의 첫 폴더가 uuid가 아니면
-- 형변환 오류로 그 읽기가 통째로 실패할 수 있다. CASE 로 순서를 보장하는 텍스트 입력 함수를 만들어 정책이 이걸 쓰게 한다.

create or replace function public.can_manage_wholesaler_folder(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select case
        when p_folder ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then public.can_manage_wholesaler_thumbnail(p_folder::uuid)
        else false
    end;
$$;

revoke all on function public.can_manage_wholesaler_folder(text) from public, anon;
grant execute on function public.can_manage_wholesaler_folder(text) to authenticated;

drop policy if exists "Product image insert by wholesaler staff" on storage.objects;
create policy "Product image insert by wholesaler staff"
on storage.objects for insert to authenticated
with check (bucket_id = 'product-images' and public.can_manage_wholesaler_folder((storage.foldername(name))[1]));

drop policy if exists "Product image update by wholesaler staff" on storage.objects;
create policy "Product image update by wholesaler staff"
on storage.objects for update to authenticated
using (bucket_id = 'product-images' and public.can_manage_wholesaler_folder((storage.foldername(name))[1]))
with check (bucket_id = 'product-images' and public.can_manage_wholesaler_folder((storage.foldername(name))[1]));

drop policy if exists "Product image delete by wholesaler staff" on storage.objects;
create policy "Product image delete by wholesaler staff"
on storage.objects for delete to authenticated
using (bucket_id = 'product-images' and public.can_manage_wholesaler_folder((storage.foldername(name))[1]));

drop policy if exists "Product image select by wholesaler staff" on storage.objects;
create policy "Product image select by wholesaler staff"
on storage.objects for select to authenticated
using (bucket_id = 'product-images' and public.can_manage_wholesaler_folder((storage.foldername(name))[1]));

drop policy if exists "Shop thumbnail select by wholesaler staff" on storage.objects;
create policy "Shop thumbnail select by wholesaler staff"
on storage.objects for select to authenticated
using (bucket_id = 'shop-thumbnails' and public.can_manage_wholesaler_folder((storage.foldername(name))[1]));
