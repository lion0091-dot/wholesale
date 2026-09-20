/**
 * 미니샵 주문 내역의 타입과 순수 함수.
 *
 * 서버 전용 의존성(next/headers, Supabase 서버 클라이언트)을 포함하지 않으므로
 * 클라이언트 컴포넌트에서도 안전하게 import 할 수 있다.
 * 실제 데이터 로딩은 서버 전용 모듈 `@/lib/shop/order-history`가 담당한다.
 */

import type { OrderStatus } from "@/types/database";

/** 취소 사유 입력 길이 제한 (알림톡 템플릿 가변 영역 기준) */
export const CANCEL_REASON_MIN_LENGTH = 5;
export const CANCEL_REASON_MAX_LENGTH = 200;

export interface ShopOrderLine {
  id: string;
  category: string | null;
  productName: string;
  unitPrice: number;
  quantity: number;
  subtotalAmount: number;
}

export interface ShopOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  totalAmount: number;
  deliveryAddress: string;
  deliveryNotes: string | null;
  orderedAt: string;
  cancelReason: string | null;
  cancelRequestedAt: string | null;
  cancelResolvedAt: string | null;
  courierCode: string | null;
  trackingNumber: string | null;
  lines: ShopOrderLine[];
}

export interface ShopOrderHistory {
  orders: ShopOrder[];
  /** 조회 결과가 비어 있는 이유 (미인증 손님 / 시연 카탈로그 등) */
  notice: string | null;
  /** 단골 인증이 필요한 상태 여부 */
  requiresLink: boolean;
}

/**
 * 취소 사유 검증 — 클라이언트 입력 가드와 서버 액션이 동일 규칙을 공유한다.
 * 통과 시 null, 실패 시 사용자에게 보여줄 메시지를 반환한다.
 */
export function validateCancelReason(raw: string): string | null {
  const reason = raw.trim();

  if (reason.length === 0) {
    return "취소 사유를 입력해주세요. 공급사가 출고 여부를 판단하는 근거가 됩니다.";
  }

  if (reason.length < CANCEL_REASON_MIN_LENGTH) {
    return `취소 사유를 ${CANCEL_REASON_MIN_LENGTH}자 이상 구체적으로 입력해주세요.`;
  }

  if (reason.length > CANCEL_REASON_MAX_LENGTH) {
    return `취소 사유는 ${CANCEL_REASON_MAX_LENGTH}자 이내로 입력해주세요.`;
  }

  return null;
}

/** 취소 요청 진행 단계 안내 문구 */
export function describeCancelProgress(order: ShopOrder): string | null {
  switch (order.status) {
    case "cancel_requested":
      return "공급사에 취소 요청이 접수되었습니다. 승인 시 취소가 확정됩니다.";
    case "cancel_rejected":
      return "공급사가 취소 요청을 반려했습니다. 발주는 기존 일정대로 진행됩니다.";
    case "cancelled":
      return "주문이 최종 취소되었습니다.";
    default:
      return null;
  }
}
