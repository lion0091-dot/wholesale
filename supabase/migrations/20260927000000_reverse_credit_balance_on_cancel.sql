-- ====================================================================
-- 외상 주문 취소 시 미수금 잔액 원상복구 (code-review 버그 수정)
--
-- 문제:
--   apply_credit_order(20260915020000)는 외상 주문 접수 시 outstanding_balance를
--   늘리지만, 그 반대(줄이는) 경로는 settle_credit_orders(정산 완료) 하나뿐이었다.
--   주문이 취소(cancelled)돼도 잔액이 줄지 않아, 취소된 주문이 여신 한도를
--   영구히 잠그거나(재주문 불가), 도매업자가 어쩔 수 없이 "정산완료"를 눌러
--   실제로 받지 않은 돈을 받은 것으로 기록하게 만들었다.
--
-- 해결:
--   상태 전이를 이미 검증/강제하고 있는 enforce_order_cancel_authority() 트리거에
--   취소 확정(NEW.status = 'cancelled') 시점의 잔액 원상복구를 추가한다.
--   이미 정산 완료된(settled_at IS NOT NULL) 주문은 잔액에서 이미 빠졌으므로
--   건드리지 않는다(중복 차감 방지).
--
-- 이 마이그레이션은 CREATE OR REPLACE로 함수 본문만 교체하므로 기존 트리거
-- 바인딩(trg_orders_cancel_authority)을 그대로 유지한다.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.enforce_order_cancel_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID := public.get_current_wholesaler_id();
    v_retailer_id   UUID := public.get_current_retailer_id();
    v_is_owner      BOOLEAN;
    v_is_buyer      BOOLEAN;
BEGIN
    v_is_owner := v_wholesaler_id IS NOT NULL AND v_wholesaler_id = OLD.wholesaler_id;
    v_is_buyer := v_retailer_id IS NOT NULL AND v_retailer_id = OLD.retailer_id;

    -- (A) 바이어(구매 회원) 경로: '취소 요청' 전이 하나만 허용
    IF v_is_buyer AND NOT v_is_owner THEN
        IF OLD.status NOT IN ('pending', 'confirmed') OR NEW.status <> 'cancel_requested' THEN
            RAISE EXCEPTION '바이어는 접수대기/확정 상태의 발주서에 대해 취소 요청만 생성할 수 있습니다.';
        END IF;

        -- 취소 요청과 무관한 컬럼은 원본 값으로 되돌린다 (금액·배송지 위조 차단).
        NEW.id                  := OLD.id;
        NEW.wholesaler_id       := OLD.wholesaler_id;
        NEW.retailer_id         := OLD.retailer_id;
        NEW.order_number        := OLD.order_number;
        NEW.total_amount        := OLD.total_amount;
        NEW.delivery_address    := OLD.delivery_address;
        NEW.delivery_notes      := OLD.delivery_notes;
        NEW.ordered_at          := OLD.ordered_at;
        NEW.cancel_resolved_at  := OLD.cancel_resolved_at;

        -- 접수 시각은 클라이언트 입력이 아니라 DB 시계로 기록한다.
        NEW.cancel_requested_at := now();
        NEW.updated_at          := now();

        RETURN NEW;
    END IF;

    -- (B) 이하 공급사/관리자 경로
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    -- 취소 '요청' 생성은 바이어 전용. 공급사는 승인/반려만 한다.
    -- (lib/orders/status.ts 의 RETAILER_ONLY_STATUSES 와 동일 규칙)
    IF NEW.status = 'cancel_requested' THEN
        RAISE EXCEPTION '취소 요청은 바이어만 생성할 수 있습니다. 공급사는 승인 또는 반려만 가능합니다.';
    END IF;

    -- 취소 요청은 승인(cancelled) 또는 반려(cancel_rejected)로만 종결한다.
    IF OLD.status = 'cancel_requested' THEN
        IF NEW.status NOT IN ('cancelled', 'cancel_rejected') THEN
            RAISE EXCEPTION '취소 요청은 취소 확정 또는 반려로만 종결할 수 있습니다.';
        END IF;

        NEW.cancel_resolved_at := now();
    END IF;

    -- 외상 주문이 (미정산 상태로) 취소 확정되면 미수금 잔액을 원상복구한다.
    IF NEW.status = 'cancelled'
       AND OLD.payment_method = 'on_credit'
       AND OLD.settled_at IS NULL THEN
        UPDATE public.wholesaler_retailers
           SET outstanding_balance = GREATEST(outstanding_balance - OLD.total_amount, 0)
         WHERE wholesaler_id = OLD.wholesaler_id
           AND retailer_id = OLD.retailer_id;
    END IF;

    RETURN NEW;
END;
$$;
