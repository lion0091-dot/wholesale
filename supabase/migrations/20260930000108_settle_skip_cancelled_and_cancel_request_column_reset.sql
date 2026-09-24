-- 5번 결제·정산 DB 테스트(scripts/db-test-payments-settlement.sql)에서 나온 발견 중 DB만으로 안전하게 고칠 수 있는 2건.
-- 함수 본문은 마이그레이션 파일이 아니라 로컬 DB의 pg_get_functiondef 결과를 기준으로 패치했다(079 방식).
--
-- 1) settle_credit_orders 가 취소된 주문을 정산 대상에서 뺀다.
--    외상 주문이 취소되면 enforce_order_cancel_authority 가 미수금을 이미 되돌리는데(settled_at 은 NULL 그대로),
--    정산 RPC 가 상태를 안 봐서 취소된 주문을 정산하면 같은 금액이 한 번 더 빠졌다.
--    화면(receivables 페이지)은 취소 주문을 목록에서 빼므로 API 직접 호출에서만 재현되던 문제.
--
-- 2) 바이어의 취소요청 UPDATE 가 결제·배송 컬럼을 바꾸지 못하게 원복한다.
--    기존 트리거는 금액·주소 등만 되돌려서, 취소요청에 payment_status·pg_payment_key·settled_at·payment_method 등을
--    끼워 보내면 그대로 저장됐다(결제 완료/환불/정산 위조). 앱의 취소요청은 status·cancel_reason·
--    cancel_requested_at·updated_at 만 쓰므로 나머지는 전부 원본으로 되돌려도 정상 흐름에 영향이 없다.
--
-- 남은 발견 3건(결제수단 허용목록·외상 한도·paid 위조·대기행 금액)은 PG 주문 생성을 서버 권한으로 옮기거나
-- 주문+미수금 반영을 한 RPC로 묶는 앱 구조 변경이 필요해 토스 실계정 연동 때 함께 다룬다
-- (docs/integration-test-plan.md 5절).

CREATE OR REPLACE FUNCTION public.settle_credit_orders(p_order_ids uuid[])
 RETURNS TABLE(retailer_id uuid, new_outstanding_balance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID := COALESCE(
        public.get_current_wholesaler_id(),
        (
            SELECT o.wholesaler_id
              FROM public.organization_staff s
              JOIN public.organizations o ON o.id = s.organization_id
             WHERE s.user_id = auth.uid()
               AND s.role = ANY(ARRAY['owner', 'manager']::public.organization_role[])
             LIMIT 1
        )
    );
BEGIN
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_WHOLESALER';
    END IF;

    RETURN QUERY
    WITH just_settled AS (
        UPDATE public.orders
        SET settled_at = now()
        WHERE id = ANY(p_order_ids)
          AND wholesaler_id = v_wholesaler_id
          AND payment_method = 'on_credit'
          AND settled_at IS NULL
          -- 취소된 주문은 취소 시점에 미수금이 이미 원복됐다 — 다시 빼면 이중 차감(108).
          AND status <> 'cancelled'
        RETURNING orders.retailer_id AS r_id, orders.total_amount AS amount
    ),
    grouped AS (
        SELECT r_id, SUM(amount) AS amount FROM just_settled GROUP BY r_id
    ),
    updated AS (
        UPDATE public.wholesaler_retailers wr
        SET outstanding_balance = GREATEST(wr.outstanding_balance - grouped.amount, 0)
        FROM grouped
        WHERE wr.wholesaler_id = v_wholesaler_id
          AND wr.retailer_id = grouped.r_id
        RETURNING wr.retailer_id, wr.outstanding_balance
    )
    SELECT updated.retailer_id, updated.outstanding_balance FROM updated;
END;
$function$;


CREATE OR REPLACE FUNCTION public.enforce_order_cancel_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

        -- 취소 요청과 무관한 컬럼은 원본 값으로 되돌린다 (금액·주소·결제 위조 차단).
        -- 앱의 취소요청이 쓰는 것은 status·cancel_reason·cancel_requested_at·updated_at 뿐이다.
        NEW.id                    := OLD.id;
        NEW.wholesaler_id         := OLD.wholesaler_id;
        NEW.retailer_id           := OLD.retailer_id;
        NEW.order_number          := OLD.order_number;
        NEW.total_amount          := OLD.total_amount;
        NEW.delivery_address      := OLD.delivery_address;
        NEW.delivery_notes        := OLD.delivery_notes;
        NEW.ordered_at            := OLD.ordered_at;
        NEW.cancel_resolved_at    := OLD.cancel_resolved_at;
        -- 108: 결제·배송 컬럼도 원복
        NEW.payment_method        := OLD.payment_method;
        NEW.payment_status        := OLD.payment_status;
        NEW.pg_payment_key        := OLD.pg_payment_key;
        NEW.pg_order_id           := OLD.pg_order_id;
        NEW.settled_at            := OLD.settled_at;
        NEW.courier_code          := OLD.courier_code;
        NEW.tracking_number       := OLD.tracking_number;
        NEW.shipment_finalized_at := OLD.shipment_finalized_at;
        NEW.negotiation_note      := OLD.negotiation_note;
        NEW.created_by            := OLD.created_by;

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
$function$;
