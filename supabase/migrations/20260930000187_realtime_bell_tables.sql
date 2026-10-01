-- 187: 종 배지(새 주문·취소 요청·확인 필요 박스)와 고객 미니샵 배송 벨을 30초 주기 조회 대신
-- Supabase Realtime으로 즉시 갱신한다. 두 표의 변화를 Realtime 발행(publication)에 올리기만 하면 된다.
--
-- 누가 어떤 행의 변화를 받는지는 기존 RLS SELECT 정책이 그대로 결정한다(Realtime은 구독자 세션으로
-- 정책을 다시 평가한다). 컬럼 권한도 그대로 적용된다. 화면은 받은 행을 쓰지 않고 "바뀌었다"는 신호로만
-- 쓰고 값은 서버에 다시 묻는다(lib/hooks/use-realtime-refresh.ts).
--
-- 호스팅 Supabase에는 supabase_realtime 발행이 이미 있다. 로컬 Docker에도 있지만 없을 때를 대비해 만든다.
-- 같은 표를 두 번 넣으면 오류라 들어있는지 먼저 본다(재실행 안전).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'orders'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'inbound_scans'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.inbound_scans;
    END IF;
END
$$;
