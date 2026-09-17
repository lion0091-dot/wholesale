-- 사업자등록증 사본 업로드용 Storage 버킷 + 정책.
--
-- 등록증엔 대표자명/주소/등록번호 등 개인·사업 정보가 그대로 담겨 있어 반드시
-- private 버킷으로 만든다. 경로 규칙은 "<auth.uid()>/..." 로 고정해, 정책이
-- storage.foldername(name)의 첫 세그먼트를 업로더 본인 UID와 비교하는 것만으로
-- 소유권을 판정할 수 있게 한다(테이블 조인 없이 바로 검증 가능).
insert into storage.buckets (id, name, public)
values ('business-licenses', 'business-licenses', false)
on conflict (id) do nothing;

-- 본인 폴더에만 업로드 가능.
create policy "Business license insert by owner"
on storage.objects for insert
to authenticated
with check (
    bucket_id = 'business-licenses'
    and (storage.foldername(name))[1] = auth.uid()::text
);

-- 본인 또는 슈퍼관리자(입점 심사)만 조회 가능.
create policy "Business license select by owner or admin"
on storage.objects for select
to authenticated
using (
    bucket_id = 'business-licenses'
    and (
        (storage.foldername(name))[1] = auth.uid()::text
        or public.get_current_role() = 'super_admin'
    )
);

-- 재업로드(교체) 허용 — 본인 파일만.
create policy "Business license update by owner"
on storage.objects for update
to authenticated
using (
    bucket_id = 'business-licenses'
    and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
    bucket_id = 'business-licenses'
    and (storage.foldername(name))[1] = auth.uid()::text
);

-- 본인 파일 삭제(재업로드 시 정리 등) 허용.
create policy "Business license delete by owner"
on storage.objects for delete
to authenticated
using (
    bucket_id = 'business-licenses'
    and (storage.foldername(name))[1] = auth.uid()::text
);
