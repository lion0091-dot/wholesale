-- 엑셀 대량 입고에 냉장/냉동 열 추가: 행별 보관방식 표기를 스캔 처리에 넘긴다.
-- 비어 있으면 기존처럼 스캔이 정하고, 못 정하면 보관(확인 필요)으로 간다.
ALTER TABLE public.inbound_import_rows
  ADD COLUMN IF NOT EXISTS storage_hint text
  CHECK (storage_hint IS NULL OR storage_hint IN ('냉장', '냉동'));
