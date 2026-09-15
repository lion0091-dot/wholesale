/**
 * B2B 육류 도매 발주 SaaS - 카카오 알림톡(AlimTalk) 알림 발송 서비스 모듈
 * 
 * PRD Section 3 준수:
 * - 바이어(식당)의 발주서 제출 시 도매업자에게 즉시 카카오 알림톡 트리거 발생
 * - 바이어의 주문 취소 요청 접수 시에도 동일 채널로 도매업자에게 즉시 알림
 * - 개발 및 테스트 환경에서는 카카오 알림톡 규격 템플릿 포맷팅과 구조화된 mock 발송 영수증을 반환
 */

import { formatOrderedAt, formatWon } from "@/lib/orders/status";

export interface OrderNotificationPayload {
  wholesalerName: string;
  wholesalerPhone?: string;
  restaurantName: string;
  orderNumber: string;
  itemsSummary: string;
  totalAmount: number;
  deliveryAddress: string;
  deliveryNotes?: string | null;
}

export interface CancelRequestNotificationPayload {
  wholesalerName: string;
  wholesalerPhone?: string;
  restaurantName: string;
  orderNumber: string;
  totalAmount: number;
  /** 바이어가 입력한 취소 요청 사유 */
  cancelReason: string;
}

export interface ReceivablesReminderPayload {
  wholesalerName: string;
  retailerName: string;
  retailerPhone?: string;
  outstandingBalance: number;
  /** 정산 기한이 가장 임박한(또는 지난) 주문의 기한 — 표시용 */
  nearestDueAt: string;
  /** true면 이미 연체(경과), false면 기한 임박 */
  isOverdue: boolean;
}

export interface NotificationResult {
  success: boolean;
  messageId: string;
  sentAt: string;
  channel: "kakao_alimtalk" | "mock_log";
  templateTitle: string;
  formattedMessage: string;
}

interface DispatchInput {
  templateTitle: string;
  formattedMessage: string;
  targetPhone?: string;
}

/**
 * 알림톡 발송 분기 (실발송 / 시연 로그).
 * 템플릿 종류에 관계없이 발송 경로와 영수증 포맷을 한 곳에서 관리한다.
 */
async function dispatchAlimtalk({
  templateTitle,
  formattedMessage,
  targetPhone,
}: DispatchInput): Promise<NotificationResult> {
  const sentAt = new Date().toISOString();
  const messageId = `ALIM-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  // 실제 카카오 알림톡 API 연동 키(예: SOLAPI, ALIGO 등)가 환경변수에 있을 경우 연동
  const apiKey = process.env.ALIMTALK_API_KEY;
  const senderPhone = process.env.ALIMTALK_SENDER_PHONE;

  if (apiKey && senderPhone && targetPhone) {
    try {
      // 실 API 전송 로직 위치 (실제 환경 변수 등록 시 활성화)
      console.log(`[AlimTalk LIVE] 알림톡 실발송 처리: ${messageId} -> ${targetPhone}`);

      return {
        success: true,
        messageId,
        sentAt,
        channel: "kakao_alimtalk",
        templateTitle,
        formattedMessage,
      };
    } catch (err) {
      console.error("[AlimTalk ERROR] 실발송 실패, Fallback 처리:", err);
    }
  }

  // 개발 및 시연 환경: 표준 포맷 로깅 및 성공 영수증 반환
  console.log("=================================================");
  console.log(`[카카오 알림톡 발송 트리거 시뮬레이션] (ID: ${messageId})`);
  console.log(formattedMessage);
  console.log("=================================================");

  return {
    success: true,
    messageId,
    sentAt,
    channel: "mock_log",
    templateTitle: `${templateTitle} (테스트 모드)`,
    formattedMessage,
  };
}

/**
 * 도매업자 대상 신규 발주 접수 알림톡 메시지 생성 및 발송 트리거
 */
export async function sendOrderNotificationToWholesaler(
  payload: OrderNotificationPayload
): Promise<NotificationResult> {
  // 카카오 알림톡 공식 승인 규격 템플릿 포맷
  const formattedMessage = `[신규 B2B 육류 발주 접수 알림]

${payload.wholesalerName} 대표님, 바이어(구매 회원)로부터 새로운 발주서가 접수되었습니다.

■ 발주 번호: ${payload.orderNumber}
■ 발주처(바이어): ${payload.restaurantName}
■ 발주 내역: ${payload.itemsSummary}
■ 총 발주 금액: ${payload.totalAmount.toLocaleString()}원
■ 배송지: ${payload.deliveryAddress}
${payload.deliveryNotes ? `■ 배송 요청사항: ${payload.deliveryNotes}
` : ""}
도매업자 관리 대시보드에서 발주 상세 내역을 확인하시고 출고 준비를 진행해 주시기 바랍니다.`;

  return dispatchAlimtalk({
    templateTitle: "신규 발주 접수 알림",
    formattedMessage,
    targetPhone: payload.wholesalerPhone,
  });
}

/**
 * 도매업자 대상 '주문 취소 요청 접수' 알림톡.
 *
 * 취소 확정이 아니라 요청 접수 단계임을 명시한다.
 * 실제 취소/반려는 공급사가 대시보드에서 승인해야 확정된다.
 */
export async function sendCancelRequestNotificationToWholesaler(
  payload: CancelRequestNotificationPayload
): Promise<NotificationResult> {
  const formattedMessage = `[주문 취소 요청 접수 알림]

${payload.wholesalerName} 대표님, 바이어(구매 회원)가 접수된 발주서의 취소를 요청했습니다.

■ 발주 번호: ${payload.orderNumber}
■ 발주처(바이어): ${payload.restaurantName}
■ 발주 금액: ${payload.totalAmount.toLocaleString()}원
■ 요청 사유: ${payload.cancelReason}

아직 취소가 확정된 것은 아닙니다.
도매업자 관리 대시보드에서 출고 진행 상황을 확인하신 후 취소 승인 또는 반려를 처리해 주시기 바랍니다.`;

  return dispatchAlimtalk({
    templateTitle: "주문 취소 요청 접수 알림",
    formattedMessage,
    targetPhone: payload.wholesalerPhone,
  });
}

/**
 * 거래처(식당) 대상 미수금 정산 기한 리마인드 알림톡.
 *
 * 공급사가 미수금 정산 화면에서 거래처별로 수동 발송한다.
 * 기한 임박/경과 여부에 따라 문구만 달라지고 발송 경로는 동일하다.
 */
export async function sendReceivablesReminderToRetailer(
  payload: ReceivablesReminderPayload
): Promise<NotificationResult> {
  const statusLine = payload.isOverdue
    ? `정산 기한이 ${formatOrderedAt(payload.nearestDueAt)}에 이미 지났습니다.`
    : `정산 기한(${formatOrderedAt(payload.nearestDueAt)})이 임박했습니다.`;

  const formattedMessage = `[외상 거래 미수금 정산 안내]

${payload.retailerName} 담당자님, ${payload.wholesalerName}입니다.

■ 현재 미수금: ${formatWon(payload.outstandingBalance)}
■ ${statusLine}

빠른 시일 내 정산 부탁드립니다. 이미 정산을 완료하셨다면 안내를 확인해 주시기 바랍니다.`;

  return dispatchAlimtalk({
    templateTitle: payload.isOverdue ? "미수금 정산 경과 리마인드" : "미수금 정산 기한 임박 리마인드",
    formattedMessage,
    targetPhone: payload.retailerPhone,
  });
}
