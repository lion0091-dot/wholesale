-- 225~227 되돌리기 (2026-10-03, 대표 결정: 도소매 플랫폼에 필요 없는 기능이라 제거)
--
-- 225(알림톡 폴백 업체별 끄기), 226(알림을 켠 기기 목록), 227(기기 지우기)을 걷어낸다. 앱 코드는 같은 날 되돌렸고
-- (공급사 주문 알림은 다시 "웹푸시 먼저, 아무도 못 받으면 알림톡"으로 고정), 여기서는 DB 흔적만 지운다.
-- 컬럼은 방금 만든 것이고 모든 업체가 기본값(켜짐)이라 사라지는 데이터가 없다. 앱 배포가 먼저 끝난 뒤에 적용한다.

DROP FUNCTION IF EXISTS public.remove_push_device(uuid);
DROP FUNCTION IF EXISTS public.list_push_devices();
ALTER TABLE public.wholesalers DROP COLUMN IF EXISTS alimtalk_fallback_enabled;
