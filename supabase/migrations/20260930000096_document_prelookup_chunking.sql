-- 명세서 이력/로트번호 사전조회를 청크 처리로 전환하기 위한 상태 컬럼 (2026-09-24).
--
-- 배경: 기존 precacheDocumentTraceNos()는 명세서 저장 액션 한 번 안에서 줄 전체를
-- Promise.all로 한꺼번에 정부 API에 쏘고 끝날 때까지 기다렸다. 로트 번호는 그 안의
-- 개체번호까지 하나하나 재확인하므로(20260930000071), 줄 수가 많으면(예: 로트
-- 20개+이력번호 100개) 실제 정부 API 호출이 300건대로 불어난다.
--
-- 같은 문제를 엑셀 대량 입고(inbound_import_jobs/rows, 13단계)에서 이미 겪어서
-- "브라우저가 시간예산(6초)만큼씩 반복 호출"하는 구조로 바꾼 전례가 있다
-- (docs/livestock-inbound-tracking.md 8번 항목, Vercel Hobby 실행시간 제한 때문).
-- 이 마이그레이션은 명세서 사전조회에도 같은 패턴을 적용하기 위한 상태 컬럼을 추가한다.
--
-- 잠긴 설계 결정:
--   1. 새 job/rows 테이블을 따로 만들지 않는다 — inbound_document_lines가 이미
--      "줄 하나 = 행 하나" 단위이므로 여기에 상태만 얹는다.
--   2. prelookup_status가 NULL인 줄은 애초에 조회 대상이 아니다(이력번호 자체가
--      없거나 우리가 발행한 세트번호라 정부 조회 불가능한 경우).
--   3. 청크 처리는 순차(sequential)로 돈다(Promise.all 금지) — 정부 API에 한 번에
--      너무 많은 동시 요청을 보내지 않기 위한 보수적 선택. 로트 안 개체 재확인은
--      기존처럼 그 로트 하나 안에서만 병렬(보통 10~20건 수준이라 안전).

ALTER TABLE public.inbound_document_lines
    ADD COLUMN IF NOT EXISTS prelookup_status TEXT
        CHECK (prelookup_status IS NULL OR prelookup_status IN ('PENDING', 'DONE', 'FAILED')),
    ADD COLUMN IF NOT EXISTS prelookup_error  TEXT;

COMMENT ON COLUMN public.inbound_document_lines.prelookup_status IS
    'NULL=조회 대상 아님(이력번호 없음/세트번호). PENDING=대기, DONE=조회 성공(또는 API 키 미설정), FAILED=정부 이력조회에서 미확인(공급처 확인 필요).';
COMMENT ON COLUMN public.inbound_document_lines.prelookup_error IS
    'FAILED일 때 사유 텍스트. 로트면 미등록 개체번호 목록이 들어갈 수 있다.';

CREATE INDEX IF NOT EXISTS idx_inbound_document_lines_prelookup_pending
    ON public.inbound_document_lines (document_id, line_no)
    WHERE prelookup_status = 'PENDING';
