/**
 * 문자 일괄발송 대기열(outbound_sms_queue) 공용 타입/문구.
 *
 * "체크박스 선택 + 일괄발송 버튼"으로 여러 건을 한 번에 실제 발송하려면 서버가 호출하는
 * 진짜 SMS API(알리고/Solapi 등) 계약이 필요하다. 아직 계약 전이라 일괄발송 버튼은 실제
 * 발송 대신 이 안내 문구만 보여준다 — 개별 건은 기존 sms: 딥링크(무료, 건별 클릭)로
 * 계속 보낼 수 있다.
 */
export const BULK_SMS_NOT_CONFIGURED_NOTICE =
  "문자 대량발송은 SMS 발송 대행사(알리고·Solapi 등) 계약 후 서버 연동이 필요합니다. 계약이 끝나면 담당 개발자에게 연동을 요청해주세요. 지금은 아래 목록에서 건별로 눌러 직접 발송해주세요.";

export interface OutboundSmsQueueRow {
  id: string;
  recipientName: string;
  recipientPhone: string;
  messageBody: string;
  status: "pending" | "sent";
  createdAt: string;
}
