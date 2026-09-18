-- ====================================================================
-- 플랫폼 구독료(거래처 수 비례 종량제) — 체험 만료 판정 기준 컬럼
--
-- 잠긴 설계 결정:
-- - 거래처 1곳(wholesaler_retailers.status = 'active')당 월 5,000원.
-- - 무료 체험 30일, 이후 미결제 시 접근 차단(middleware).
-- - 기존 계정을 가입일(created_at) 기준으로 소급 적용하면 오래된 계정이
--   배포 즉시 무더기로 잠길 위험이 있어, 별도 컬럼을 두고 기존 행은 전부
--   "오늘부터 30일"로 리셋한다. DEFAULT now()가 ALTER 시점에 기존 행에도
--   적용되므로 별도 UPDATE문 없이 이 한 문장으로 충분하다.
-- - 결제 자동화(빌링키 등)는 아직 미정 — 지금은 super_admin이
--   /admin/suppliers에서 수동으로 subscription_status를 바꾸는 방식 유지.
-- ====================================================================
alter table public.wholesalers
  add column if not exists trial_started_at timestamptz not null default now();

comment on column public.wholesalers.trial_started_at is
  '무료 체험 시작 시각. subscription_status=trial일 때 이 시각+30일이 지나면 대시보드 접근이 차단된다.';
