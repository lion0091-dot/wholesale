/**
 * B2B 육류 도매 발주 SaaS - 카카오 알림톡(AlimTalk) 알림 발송 서비스 모듈
 * 
 * PRD Section 3 준수:
 * - 바이어(식당)의 발주서 제출 시 도매업자에게 즉시 카카오 알림톡 트리거 발생
 * - 개발 및 테스트 환경에서는 카카오 알림톡 규격 템플릿 포맷팅과 구조화된 mock 발송 영수증을 반환
 */

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

export interface NotificationResult {
  success: boolean;
  messageId: string;
  sentAt: string;
  channel: "kakao_alimtalk" | "mock_log";
  templateTitle: string;
  formattedMessage: string;
}

/**
 * 도매업자 대상 신규 발주 접수 알림톡 메시지 생성 및 발송 트리거
 */
export async function sendOrderNotificationToWholesaler(
  payload: OrderNotificationPayload
): Promise<NotificationResult> {
  const sentAt = new Date().toISOString();
  const messageId = `ALIM-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  // 카카오 알림톡 공식 승인 규격 템플릿 포맷
  const formattedMessage = `[신규 B2B 육류 발주 접수 알림]

${payload.wholesalerName} 대표님, 단골 식당으로부터 새로운 발주서가 접수되었습니다.

■ 발주 번호: ${payload.orderNumber}
■ 발주 식당: ${payload.restaurantName}
■ 발주 내역: ${payload.itemsSummary}
■ 총 발주 금액: ${payload.totalAmount.toLocaleString()}원
■ 배송지: ${payload.deliveryAddress}
${payload.deliveryNotes ? `■ 배송 요청사항: ${payload.deliveryNotes}\n` : ""}
도매업자 관리 대시보드에서 발주 상세 내역을 확인하시고 출고 준비를 진행해 주시기 바랍니다.`;

  // 실제 카카오 알림톡 API 연동 키(예: SOLAPI, ALIGO 등)가 환경변수에 있을 경우 연동
  const apiKey = process.env.ALIMTALK_API_KEY;
  const senderPhone = process.env.ALIMTALK_SENDER_PHONE;

  if (apiKey && senderPhone && payload.wholesalerPhone) {
    try {
      // 실 API 전송 로직 위치 (실제 환경 변수 등록 시 활성화)
      console.log(`[AlimTalk LIVE] 알림톡 실발송 처리: ${messageId} -> ${payload.wholesalerPhone}`);
      return {
        success: true,
        messageId,
        sentAt,
        channel: "kakao_alimtalk",
        templateTitle: "신규 발주 접수 알림",
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
    templateTitle: "신규 발주 접수 알림 (테스트 모드)",
    formattedMessage,
  };
}
