-- 공급사별 "과금 시작일" — 지금 당장은 전체 공급사에 대해 언제부터 실제로 과금을
-- 시작할지 결정하기 어려워서, 기본값(NULL)은 "과금 절대 시작 안 함"(체험 만료
-- 여부와 무관하게 백오피스 접근 차단 없음)을 뜻한다. super_admin이 공급사별로
-- 이 날짜를 지정해야 비로소 그때부터 기존 체험/연체/해지 차단 로직이 적용된다.
--
-- 기존 마이그레이션(20260930000038, trial_started_at)과 달리 이번엔 DEFAULT now()를
-- 주지 않는다 — 그러면 배포 즉시 전원이 "지금부터 과금 시작"이 되어 정반대 효과를
-- 낸다. NULL 그대로 두는 게 이번 요구사항("당분간 비과금")과 정확히 일치한다.
alter table public.wholesalers
    add column if not exists billing_starts_at timestamptz;
