-- 은행 거래내역 대사(reconcile)를 시도했지만 매칭되는 입금 거래를 못 찾은 미납
-- 청구서를 화면에서 구분할 수 있게 한다. 상세 사유 텍스트까지는 남기지 않고(그건
-- memo 자유기입으로 이미 가능), "대사를 시도했는데도 여전히 미납"이라는 사실 자체만
-- 구조화된 필드로 기록한다 — 관리자가 "아직 한 번도 대사 안 해본 미납"과 "대사했는데
-- 매칭이 안 되는 미납(번호 오류·미입금 등 확인 필요)"을 구별할 수 있게 하기 위함.
alter table public.platform_subscription_invoices
    add column last_reconcile_attempted_at timestamptz;

comment on column public.platform_subscription_invoices.last_reconcile_attempted_at is
    '은행 거래내역 대사 시도 시점(도구가 후보로 들고 있었지만 이번에 매칭되지 않은 경우). 완납 처리되면 다시 null로 초기화한다.';
