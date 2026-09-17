-- 사업자등록증 사본 업로드 여부/경로 추적.
--
-- 실제 파일은 storage.objects(business-licenses 버킷, "<auth.uid()>/..." 경로)에 있고,
-- 여기엔 그 경로와 업로드 시각만 캐싱해서 관리자 목록 화면이 매번 Storage를
-- list-and-check 하지 않고 wholesalers 조회 한 번으로 "제출됨/안됨"을 판단할 수 있게 한다.
alter table public.wholesalers
    add column business_license_path text,
    add column business_license_uploaded_at timestamptz;

comment on column public.wholesalers.business_license_path is
    'storage.objects 내 사업자등록증 사본 경로("<profile_id>/파일명"). null이면 미제출. 실제 조회는 서명된 URL로만.';
comment on column public.wholesalers.business_license_uploaded_at is
    '마지막 사업자등록증 업로드 시각.';
