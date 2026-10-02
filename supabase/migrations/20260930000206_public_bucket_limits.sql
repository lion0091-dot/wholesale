-- 공개 버킷 2개에 용량·형식 상한을 건다. 서버 액션(products/actions.ts, supplier-auth.ts)이 이미 같은 값(4MB, 형식)을
-- 검사하지만, 직원 계정이 스토리지 API로 직접 올리면 그 검사를 우회한다. 서버 값과 동일하게 맞춘 뒷문 방어(이미지는 줄이지 않는다).
update storage.buckets
   set file_size_limit = 4 * 1024 * 1024,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'product-images';

update storage.buckets
   set file_size_limit = 4 * 1024 * 1024,
       allowed_mime_types = array['image/jpeg', 'image/png']
 where id = 'shop-thumbnails';
