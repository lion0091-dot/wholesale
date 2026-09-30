-- 엑셀 대량 입고에 부위 열 추가: 공공 이력조회가 부위를 주지 않으므로 행별 부위 표기를 스캔 처리(partHint)에 넘긴다.
ALTER TABLE public.inbound_import_rows
  ADD COLUMN IF NOT EXISTS part_hint text
  CHECK (part_hint IS NULL OR char_length(part_hint) <= 40);
