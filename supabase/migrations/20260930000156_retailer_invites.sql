-- ====================================================================
-- 손님(소매) 초대 — 대상 전화번호 등록 (경쟁사 위장가입 방지 1단계)
--
-- 배경: 지금까지 미니샵 링크(shop_token)는 평생 고정된 하나의 URL이고,
--   "그 링크를 갖고 있다는 사실 자체가 초대의 증거"로 취급돼(claim_shop_access)
--   승인 절차 없이 누구든 열면 즉시 손님으로 등록됐다. 손님이 그 링크를
--   실수로든 의도적으로든 경쟁사(다른 도매)에게 전달하면, 그 경쟁사가 아무
--   카카오 계정으로 열어도 걸러지지 않았다.
--
-- 설계: 공급사가 초대장을 발부할 때 "이 초대는 이 전화번호용"이라고 등록해
--   둔다. 손님이 그 번호로 카카오 로그인하면 자동 승인(active), 번호가
--   다르거나 아예 없으면(카카오가 전화번호를 안 넘겨준 경우 포함)
--   'pending_review'로 떨어져 공급사가 직접 확인해야 뚫린다(157에서 처리).
--
-- 미사용 초대는 계속 쌓아두지 않는다 — expires_at 지난 미사용(consumed_at
-- NULL) 행은 크론(app/api/cron/expire-retailer-invites)이 매일 실제로
-- 삭제한다(개인정보 목적 달성 후 보관 금지 원칙).
-- ====================================================================

CREATE TABLE public.retailer_invites (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id        UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    phone                TEXT NOT NULL,
    customer_name        TEXT,
    created_by           UUID REFERENCES public.profiles(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at           TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
    consumed_at          TIMESTAMPTZ,
    consumed_retailer_id UUID REFERENCES public.retailers(id),
    CHECK (length(phone) >= 9)
);

COMMENT ON TABLE public.retailer_invites IS
    '공급사가 등록한 "이 전화번호는 손님으로 초대했다" 기록. claim_shop_access()가 자동승인 여부를 판정할 때 대조한다.';

-- 미소진 초대는 같은 (공급사, 전화번호) 조합으로 하나만 유지 — 재초대는 갱신(upsert)한다.
CREATE UNIQUE INDEX idx_retailer_invites_pending_unique
    ON public.retailer_invites (wholesaler_id, phone)
    WHERE consumed_at IS NULL;

CREATE INDEX idx_retailer_invites_expiry ON public.retailer_invites (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE public.retailer_invites ENABLE ROW LEVEL SECURITY;

-- 공급사(owner/manager)는 자기 초대만 보고 지울 수 있다. 생성·매칭·소진 처리는
-- 전부 SECURITY DEFINER 함수(157)로만 하므로 직접 INSERT/UPDATE 정책은 두지 않는다.
CREATE POLICY retailer_invites_select ON public.retailer_invites
    FOR SELECT USING (public.can_manage_wholesaler(wholesaler_id));

CREATE POLICY retailer_invites_delete ON public.retailer_invites
    FOR DELETE USING (public.can_manage_wholesaler(wholesaler_id));

-- anon/authenticated 직접 쓰기 금지 — service_role(크론)과 SECURITY DEFINER 함수만 쓴다.
REVOKE INSERT, UPDATE ON public.retailer_invites FROM authenticated, anon;
