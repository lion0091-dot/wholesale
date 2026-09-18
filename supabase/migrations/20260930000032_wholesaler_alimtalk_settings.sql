-- 공급사가 카카오 알림톡 발송대행사(비즈뿌리오 등)와 1:1로 직접 계약하는 구조라,
-- 플랫폼 전체가 공유하는 환경변수 하나가 아니라 공급사별로 자기 자격정보를 저장해야 한다.
--
-- alimtalk_password_encrypted: 비즈뿌리오 인증은 계정+비밀번호(Basic auth)로 24시간짜리
-- 토큰을 매번 재발급받는 방식이라 평문 저장이 불가피해 보이지만, 그러면 유출 시 그 공급사
-- 명의로 메시지가 발송/과금될 수 있어 평문 저장을 하지 않는다. 애플리케이션 레이어에서
-- AES-256-GCM으로 암호화한 값(iv:authTag:ciphertext, 전부 base64)만 저장하고, 복호화는
-- 발송 시점에 서버에서만 수행한다(CREDENTIAL_ENCRYPTION_KEY, lib/security/credential-crypto.ts).
--
-- alimtalk_template_codes: 카카오 승인 템플릿 코드는 공급사마다(발신프로필마다) 다르게
-- 발급되므로, 내부 템플릿 키(order_new/cancel_request/credit_exceeded/receivables_reminder)
-- -> 비즈뿌리오 templatecode 매핑을 jsonb로 유연하게 둔다(템플릿 종류가 늘어나도 컬럼 추가 불필요).
--
-- 새 RLS 정책은 필요 없다 — wholesalers 테이블 기존 정책("Wholesalers updatable by self or
-- admin", profile_id = auth.uid())이 새 컬럼에도 그대로 적용된다(PostgreSQL RLS는 행 단위라
-- 컬럼 추가로 정책을 다시 안 만들어도 됨). 미니샵 카탈로그 쪽 select는 컬럼을 명시적으로
-- 나열해서 조회하므로(lib/shop/catalog.ts) 이 컬럼들이 바이어에게 노출될 일도 없다.
alter table public.wholesalers
    add column alimtalk_provider           text,
    add column alimtalk_account            text,
    add column alimtalk_password_encrypted text,
    add column alimtalk_sender_key         text,
    add column alimtalk_sender_phone       text,
    add column alimtalk_template_codes     jsonb not null default '{}'::jsonb;
