-- 수납 시 실제 입금액을 별도로 기록해 청구액과 다를 때 화면에서 바로 알아볼 수 있게 한다.
--
-- 배경: 지금까지는 완납 처리가 순수 이분법(paid/unpaid)이라, 은행 거래내역 대사에서
-- 관리자가 실수로(혹은 부분입금을) 엉뚱한 금액의 청구서에 매칭해도 시스템은 그냥
-- "완납"으로만 기록했다 — 실제 얼마가 들어왔는지는 memo 텍스트에만 남아 조회/집계가
-- 안 됐다. paid_amount를 구조화된 필드로 분리해서 amount(청구액)와 다르면 화면에서
-- 불일치로 표시할 수 있게 한다.
--
-- 이 컬럼을 추가하기 전에 이미 완납 처리된 기존 행은 실제 입금액을 알 수 없으므로
-- null로 둔다(화면에서는 "수납액 미기록"으로 구분 — 불일치로 오인하지 않도록 amount와
-- 다르다는 경고와는 별개로 취급한다).
alter table public.platform_subscription_invoices
    add column paid_amount numeric;

comment on column public.platform_subscription_invoices.paid_amount is
    '실제 입금 확인된 금액. amount(청구액)와 다르면 화면에서 불일치로 표시한다. status가 unpaid로 되돌아가면 null로 초기화한다. 이 컬럼 도입 이전에 완납 처리된 행은 null(수납액 미기록).';
