-- ====================================================================
-- 외상거래(여신) 관리: 스키마 컬럼 추가 (ROADMAP Post-MVP #6, 체크리스트 1,2)
-- 잔액 증감 로직/정산 화면/RLS 정책 변경은 포함하지 않음 (후속 단계에서 진행)
-- ====================================================================

-- wholesaler_retailers: 거래처별 여신 한도 및 미수금 잔액
ALTER TABLE public.wholesaler_retailers
    ADD COLUMN credit_limit NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    ADD COLUMN outstanding_balance NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (outstanding_balance >= 0);

-- orders: 결제수단 (선결제/현금 vs 외상)
ALTER TABLE public.orders
    ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'prepaid'
        CHECK (payment_method IN ('prepaid', 'on_credit'));
