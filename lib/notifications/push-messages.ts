/**
 * 웹푸시 알림 문구 — 공급사용 4종. 알림톡 본문과 달리 폰 알림 한 칸에 들어가야 하므로 짧게 쓴다.
 * 서버 전용 의존성이 없어 어디서나 import할 수 있다(실제 발송은 lib/notifications/web-push.ts).
 */

export interface PushMessage {
  title: string;
  body: string;
  /** 알림을 누르면 여는 화면(사이트 안 경로) */
  url: string;
  /** 같은 tag의 알림은 하나로 겹친다(주문 하나에 알림 여러 번 안 쌓이게) */
  tag?: string;
}

const ORDERS_URL = "/dashboard/orders";

function won(amount: number): string {
  return `${Math.round(amount).toLocaleString("ko-KR")}원`;
}

export function newOrderPush(input: { restaurantName: string; orderNumber: string; itemsSummary: string; totalAmount: number }): PushMessage {
  return {
    title: `새 주문 · ${input.restaurantName}`,
    body: `${input.itemsSummary} · ${won(input.totalAmount)}`,
    url: ORDERS_URL,
    tag: `order:${input.orderNumber}`,
  };
}

export function orderEditedPush(input: { restaurantName: string; orderNumber: string; itemsSummary: string; totalAmount: number }): PushMessage {
  return {
    title: `주문 수정 · ${input.restaurantName}`,
    body: `${input.itemsSummary} · ${won(input.totalAmount)} (접수 전 주문이 바뀌었습니다)`,
    url: ORDERS_URL,
    tag: `order:${input.orderNumber}`,
  };
}

export function cancelRequestPush(input: { restaurantName: string; orderNumber: string; totalAmount: number; cancelReason: string }): PushMessage {
  const reason = input.cancelReason.trim();

  return {
    title: `취소 요청 · ${input.restaurantName}`,
    body: `${won(input.totalAmount)}${reason ? ` · 사유: ${reason}` : ""} — 승인 또는 반려해 주세요`,
    url: ORDERS_URL,
    tag: `order:${input.orderNumber}`,
  };
}

export function creditExceededPush(input: { restaurantName: string; attemptedAmount: number; outstandingBalance: number }): PushMessage {
  return {
    title: `외상 주문 거절 · ${input.restaurantName}`,
    body: `${won(input.attemptedAmount)} 주문이 여신 한도를 넘어 접수되지 않았습니다 (미수금 ${won(input.outstandingBalance)})`,
    url: "/dashboard/receivables",
  };
}
