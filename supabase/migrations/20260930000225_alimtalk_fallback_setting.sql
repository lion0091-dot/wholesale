-- 공급사별 "주문 알림 알림톡 폴백" 켜고 끄기 (2026-10-03, 대표 결정: 앱·채널 정리)
--
-- 공급사용 알림 4종(신규 주문·주문 수정·취소 요청·여신 초과 거절)은 웹푸시가 먼저 가고, 켠 브라우저가 하나도 못 받았을 때만
-- 알림톡으로 간다(lib/notifications/wholesaler-alerts.ts). 이 폴백을 업체가 끌 수 있게 한다 — 끄면 푸시를 못 받은 주문은
-- 알림톡 없이 지나가므로(화면의 빨간 줄·종 배지로만 확인), 기본은 켜짐(지금 동작 그대로)이다.
--
-- 컬럼 이름이 alimtalk_ 로 시작해 마이그 110의 규칙대로 클라이언트 세션(anon·authenticated)은 읽지 못한다(GRANT 안 함).
-- 서버 코드가 service_role로 읽고 쓴다(lib/security/wholesaler-credentials.ts), 설정 변경은 owner·manager만.

ALTER TABLE public.wholesalers
    ADD COLUMN IF NOT EXISTS alimtalk_fallback_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.wholesalers.alimtalk_fallback_enabled IS
    '공급사용 주문 알림 4종: 웹푸시를 아무도 못 받았을 때 알림톡으로 보낼지(기본 true). false면 알림톡 없이 지나간다(20260930000225).';
