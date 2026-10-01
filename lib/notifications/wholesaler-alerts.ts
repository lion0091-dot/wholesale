/**
 * 공급사용 알림 4종의 채널 선택 — 웹푸시가 먼저, 알림톡은 푸시 켠 사람이 아무도 없을 때만.
 *
 * 2026-10-01 사장님 결정: 신규 주문·주문 수정·취소 요청·여신 초과 거절은 알림톡(대표 1명 번호, 건당 비용)
 * 대신 웹푸시(켠 직원 전원, 무료)로 보낸다. 업체에 켜 둔 브라우저가 하나라도 있으면 알림톡은 생략한다 —
 * 전달 실패까지 알림톡으로 메우진 않는다(푸시는 최선 전달이라 "켰으면 푸시만"이 규칙).
 * 키가 없거나 아무도 안 켰으면 지금까지처럼 알림톡이 나간다.
 *
 * 호출부는 전처럼 NotificationResult(messageId)를 받는다 — 푸시만 나간 경우 messageId는 PUSH-… 가짜 번호다.
 */

import {
  sendCancelRequestNotificationToWholesaler,
  sendCreditLimitExceededNotificationToWholesaler,
  sendOrderEditedNotificationToWholesaler,
  sendOrderNotificationToWholesaler,
  type CancelRequestNotificationPayload,
  type CreditLimitExceededNotificationPayload,
  type NotificationResult,
  type OrderEditedNotificationPayload,
  type OrderNotificationPayload,
} from "@/lib/notifications/alimtalk";
import { cancelRequestPush, creditExceededPush, newOrderPush, orderEditedPush, type PushMessage } from "@/lib/notifications/push-messages";
import { sendWholesalerPush } from "@/lib/notifications/web-push";

function pushOnlyResult(message: PushMessage): NotificationResult {
  return {
    success: true,
    status: "sent",
    messageId: `PUSH-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
    sentAt: new Date().toISOString(),
    templateTitle: message.title,
    formattedMessage: `${message.title}\n${message.body}`,
  };
}

async function pushThenAlimtalk(
  wholesalerId: string | null,
  message: PushMessage,
  alimtalk: () => Promise<NotificationResult>
): Promise<NotificationResult> {
  if (wholesalerId) {
    const pushed = await sendWholesalerPush(wholesalerId, message);

    if (pushed.subscribers > 0) return pushOnlyResult(message);
  }

  return alimtalk();
}

export function notifyWholesalerNewOrder(payload: OrderNotificationPayload): Promise<NotificationResult> {
  return pushThenAlimtalk(payload.wholesalerId, newOrderPush(payload), () => sendOrderNotificationToWholesaler(payload));
}

export function notifyWholesalerOrderEdited(payload: OrderEditedNotificationPayload): Promise<NotificationResult> {
  return pushThenAlimtalk(payload.wholesalerId, orderEditedPush(payload), () => sendOrderEditedNotificationToWholesaler(payload));
}

export function notifyWholesalerCancelRequest(payload: CancelRequestNotificationPayload): Promise<NotificationResult> {
  return pushThenAlimtalk(payload.wholesalerId, cancelRequestPush(payload), () => sendCancelRequestNotificationToWholesaler(payload));
}

export function notifyWholesalerCreditExceeded(payload: CreditLimitExceededNotificationPayload): Promise<NotificationResult> {
  return pushThenAlimtalk(payload.wholesalerId, creditExceededPush(payload), () =>
    sendCreditLimitExceededNotificationToWholesaler(payload)
  );
}
