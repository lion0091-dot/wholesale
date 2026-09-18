/**
 * B2B 육류 도매 발주 SaaS - 카카오 알림톡(AlimTalk) 알림 발송 서비스 모듈
 *
 * 플랫폼은 알림톡 발송대행사(현재 비즈뿌리오 고정)와 계약을 대신 해주지 않는다 —
 * 공급사가 각자 자기 명의로 대행사와 1:1 계약하고, 그 계정 정보를 대시보드
 * (/dashboard/invites, app/actions/alimtalk-settings.ts)에 직접 입력한다. 그래서
 * 이 모듈은 플랫폼 전체가 공유하는 API 키가 아니라 매 호출마다 wholesalerId로
 * 그 공급사의 자격정보를 DB에서 찾아 쓴다.
 *
 * 미설정(아직 등록 안 함) / 인증정보 오류(복호화 실패 등) / 실제 API 오류 세 가지를
 * 구분해서 반환한다 — 미설정은 정상적인 상태(알림톡을 아직 안 쓰는 공급사)라 조용히
 * 넘어가고, 나머지 둘은 콘솔에 로그를 남긴다.
 */

import { formatOrderedAt, formatWon } from "@/lib/orders/status";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { decryptCredential } from "@/lib/security/credential-crypto";
import { sendAlimtalk, BizppurioError } from "@/lib/notifications/bizppurio-client";
import type { AlimtalkTemplateKey } from "@/lib/notifications/alimtalk-templates";

export type { AlimtalkTemplateKey } from "@/lib/notifications/alimtalk-templates";

/**
 * 비즈뿌리오 알림톡(AT/AI/FT) 상태코드 중 "설정 화면에서 흔히 낼 법한 실수"에
 * 해당하는 것만 사람이 알아보기 쉬운 문구로 바꾼다(공식 문서 status-code/at-ai-ft
 * 기준, 2026-09-18). 목록에 없는 코드는 원본 description을 그대로 보여준다.
 */
const KNOWN_BIZPPURIO_ERROR_CODES: Record<number, string> = {
  7204: "메시지 문구가 승인받은 템플릿과 다릅니다. 설정 화면의 문구를 그대로 심사 신청했는지 확인해주세요.",
  7315: "템플릿 코드가 잘못됐거나 아직 카카오 승인이 완료되지 않았습니다.",
  7327: "버튼/바로연결 내용이 승인받은 템플릿과 다릅니다.",
  7328: "메시지 강조 표기 타이틀이 승인받은 템플릿과 다릅니다.",
  7330: "메시지 타입이 승인받은 템플릿의 강조유형과 다릅니다.",
  7331: "메시지 헤더가 승인받은 템플릿과 다릅니다.",
  7333: "아이템 하이라이트 내용이 승인받은 템플릿과 다릅니다.",
  7336: "아이템 리스트 내용이 승인받은 템플릿과 다릅니다.",
  7338: "아이템 요약정보가 승인받은 템플릿과 다릅니다.",
  7342: "대표링크가 승인받은 템플릿과 다릅니다.",
};

function describeBizppurioSendError(code: number | null, description: string | null): string {
  const known = code !== null ? KNOWN_BIZPPURIO_ERROR_CODES[code] : undefined;

  if (known) {
    return `${known} (코드 ${code})`;
  }

  if (description) {
    return `${description}${code !== null ? ` (코드 ${code})` : ""}`;
  }

  return code !== null ? `비즈뿌리오가 발송을 거부했습니다 (코드 ${code}).` : "비즈뿌리오가 발송을 거부했습니다.";
}

export interface OrderNotificationPayload {
  /** 데모/미연결 주문이면 null — 이 경우 발송 자체를 스킵한다 */
  wholesalerId: string | null;
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
  wholesalerId: string;
  wholesalerName: string;
  wholesalerPhone?: string;
  restaurantName: string;
  orderNumber: string;
  totalAmount: number;
  /** 바이어가 입력한 취소 요청 사유 */
  cancelReason: string;
}

export interface CreditLimitExceededNotificationPayload {
  wholesalerId: string;
  wholesalerName: string;
  wholesalerPhone?: string;
  restaurantName: string;
  creditLimit: number;
  outstandingBalance: number;
  /** 거절된 주문의 시도 금액 */
  attemptedAmount: number;
}

export interface ReceivablesReminderPayload {
  wholesalerId: string;
  wholesalerName: string;
  retailerName: string;
  retailerPhone?: string;
  outstandingBalance: number;
  /** 정산 기한이 가장 임박한(또는 지난) 주문의 기한 — 표시용 */
  nearestDueAt: string;
  /** true면 이미 연체(경과), false면 기한 임박 */
  isOverdue: boolean;
}

export interface CreditLimitIncreasedNotificationPayload {
  wholesalerId: string;
  wholesalerName: string;
  retailerName: string;
  retailerPhone?: string;
}

export interface CreditLimitExceededRetailerNotificationPayload {
  wholesalerId: string;
  wholesalerName: string;
  retailerName: string;
  retailerPhone?: string;
}

export interface CreditLimitChangedNotificationPayload {
  wholesalerId: string;
  wholesalerName: string;
  wholesalerPhone?: string;
  /** 실제로 한도를 변경한 직원/대표 이름 ("님"은 메시지에서 붙인다) */
  actorName: string;
  retailerName: string;
  previousLimit: number;
  newLimit: number;
}

export interface RetailerBlockedNotificationPayload {
  wholesalerId: string;
  wholesalerName: string;
  wholesalerPhone?: string;
  /** 실제로 정지 처리한 직원/대표 이름 ("님"은 메시지에서 붙인다) */
  actorName: string;
  retailerName: string;
  reason: string;
}

export interface RetailerResumedNotificationPayload {
  wholesalerId: string;
  wholesalerName: string;
  wholesalerPhone?: string;
  /** 실제로 재개 처리한 직원/대표 이름 ("님"은 메시지에서 붙인다) */
  actorName: string;
  retailerName: string;
}

export interface RetailerStatusRetailerNotificationPayload {
  wholesalerId: string;
  wholesalerName: string;
  retailerName: string;
  retailerPhone?: string;
}

export interface NotificationResult {
  success: boolean;
  /** sent: 실제 발송 시도까지 감. not_configured: 정상적인 미설정 상태. error: 설정은 있는데 실패. */
  status: "sent" | "not_configured" | "error";
  messageId: string;
  sentAt: string;
  templateTitle: string;
  formattedMessage: string;
  error?: string;
}

interface WholesalerAlimtalkCredentials {
  account: string;
  /** 복호화된 원문 — 이 함수 밖으로 절대 리턴/로그하지 않는다 */
  password: string;
  senderKey: string;
  senderPhone: string;
  templateCodes: Partial<Record<AlimtalkTemplateKey, string>>;
}

type CredentialLoadResult =
  | { state: "ready"; creds: WholesalerAlimtalkCredentials }
  | { state: "not_configured" }
  | { state: "invalid" };

/** 공급사의 알림톡 자격정보를 service_role로 조회하고 비밀번호를 복호화한다. */
async function loadCredentials(wholesalerId: string): Promise<CredentialLoadResult> {
  const supabase = createServiceRoleClient();

  if (!supabase) {
    return { state: "not_configured" };
  }

  const { data } = await supabase
    .from("wholesalers")
    .select(
      "alimtalk_account, alimtalk_password_encrypted, alimtalk_sender_key, alimtalk_sender_phone, alimtalk_template_codes"
    )
    .eq("id", wholesalerId)
    .maybeSingle();

  if (
    !data ||
    !data.alimtalk_account ||
    !data.alimtalk_password_encrypted ||
    !data.alimtalk_sender_key ||
    !data.alimtalk_sender_phone
  ) {
    return { state: "not_configured" };
  }

  let password: string;

  try {
    password = decryptCredential(data.alimtalk_password_encrypted as string);
  } catch {
    return { state: "invalid" };
  }

  return {
    state: "ready",
    creds: {
      account: data.alimtalk_account as string,
      password,
      senderKey: data.alimtalk_sender_key as string,
      senderPhone: data.alimtalk_sender_phone as string,
      templateCodes:
        (data.alimtalk_template_codes as Partial<Record<AlimtalkTemplateKey, string>> | null) ?? {},
    },
  };
}

interface DispatchInput {
  wholesalerId: string | null;
  templateKey: AlimtalkTemplateKey;
  templateTitle: string;
  formattedMessage: string;
  targetPhone?: string;
}

async function dispatchAlimtalk({
  wholesalerId,
  templateKey,
  templateTitle,
  formattedMessage,
  targetPhone,
}: DispatchInput): Promise<NotificationResult> {
  const sentAt = new Date().toISOString();
  const messageId = `ALIM-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  const base = { messageId, sentAt, templateTitle, formattedMessage };

  if (!wholesalerId || !targetPhone) {
    return { ...base, success: false, status: "not_configured" };
  }

  const credentialState = await loadCredentials(wholesalerId);

  if (credentialState.state === "not_configured") {
    return { ...base, success: false, status: "not_configured" };
  }

  if (credentialState.state === "invalid") {
    console.error(`[AlimTalk] 공급사(${wholesalerId}) 인증정보 복호화 실패 — 설정 재입력 필요`);
    return {
      ...base,
      success: false,
      status: "error",
      error: "알림톡 연동 정보가 유효하지 않습니다. 설정 화면에서 다시 등록해주세요.",
    };
  }

  const { creds } = credentialState;
  const templateCode = creds.templateCodes[templateKey];

  if (!templateCode) {
    return {
      ...base,
      success: false,
      status: "not_configured",
      error: `"${templateTitle}" 템플릿 코드가 아직 등록되지 않았습니다.`,
    };
  }

  try {
    const result = await sendAlimtalk({
      account: creds.account,
      password: creds.password,
      senderKey: creds.senderKey,
      from: creds.senderPhone,
      to: targetPhone,
      templateCode,
      message: formattedMessage,
      refkey: messageId,
    });

    if (!result.accepted) {
      return {
        ...base,
        success: false,
        status: "error",
        error: describeBizppurioSendError(result.code, result.description),
      };
    }

    return { ...base, success: true, status: "sent" };
  } catch (error) {
    const message =
      error instanceof BizppurioError ? error.message : "알림톡 발송 중 오류가 발생했습니다.";
    console.error(`[AlimTalk] 발송 실패 (${templateTitle}):`, message);

    return { ...base, success: false, status: "error", error: message };
  }
}

/**
 * 도매업자 대상 신규 발주 접수 알림톡 메시지 생성 및 발송 트리거
 */
export async function sendOrderNotificationToWholesaler(
  payload: OrderNotificationPayload
): Promise<NotificationResult> {
  // 카카오 알림톡 승인 템플릿으로 등록해야 하는 기준 문구
  const formattedMessage = `[신규 B2B 육류 발주 접수 알림]

${payload.wholesalerName} 대표님, 고객(소매)로부터 새로운 발주서가 접수되었습니다.

■ 발주 번호: ${payload.orderNumber}
■ 발주처(소매): ${payload.restaurantName}
■ 발주 내역: ${payload.itemsSummary}
■ 총 발주 금액: ${payload.totalAmount.toLocaleString()}원
■ 배송지: ${payload.deliveryAddress}
${payload.deliveryNotes ? `■ 배송 요청사항: ${payload.deliveryNotes}
` : ""}
공급사(도매) 관리 대시보드에서 발주 상세 내역을 확인하시고 출고 준비를 진행해 주시기 바랍니다.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "orderNew",
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

${payload.wholesalerName} 대표님, 고객(소매)가 접수된 발주서의 취소를 요청했습니다.

■ 발주 번호: ${payload.orderNumber}
■ 발주처(소매): ${payload.restaurantName}
■ 발주 금액: ${payload.totalAmount.toLocaleString()}원
■ 요청 사유: ${payload.cancelReason}

아직 취소가 확정된 것은 아닙니다.
공급사(도매) 관리 대시보드에서 출고 진행 상황을 확인하신 후 취소 승인 또는 반려를 처리해 주시기 바랍니다.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "cancelRequest",
    templateTitle: "주문 취소 요청 접수 알림",
    formattedMessage,
    targetPhone: payload.wholesalerPhone,
  });
}

/**
 * 도매업자 대상 '여신 한도 초과로 주문 거절' 알림톡.
 *
 * 바이어가 외상 주문을 시도했으나 한도 초과로 주문 자체가 성립되지 않았을 때 트리거된다.
 * (사전 체크 또는 apply_credit_order RPC 백스톱 두 경로 모두 이 함수를 호출한다)
 */
export async function sendCreditLimitExceededNotificationToWholesaler(
  payload: CreditLimitExceededNotificationPayload
): Promise<NotificationResult> {
  const formattedMessage = `[여신 한도 초과 - 외상 주문 거절 안내]

${payload.wholesalerName} 대표님, ${payload.restaurantName}에서 외상 주문을 시도했으나 여신 한도를
초과하여 주문이 접수되지 않았습니다.

■ 여신 한도: ${formatWon(payload.creditLimit)}
■ 현재 미수금: ${formatWon(payload.outstandingBalance)}
■ 시도한 주문 금액: ${formatWon(payload.attemptedAmount)}

미수금 정산 화면에서 정산 처리하거나 거래처 한도를 조정하시면 재주문이 가능합니다.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "creditExceeded",
    templateTitle: "여신 한도 초과 주문 거절 안내",
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
    wholesalerId: payload.wholesalerId,
    templateKey: "receivablesReminder",
    templateTitle: payload.isOverdue ? "미수금 정산 경과 리마인드" : "미수금 정산 기한 임박 리마인드",
    formattedMessage,
    targetPhone: payload.retailerPhone,
  });
}

/**
 * 거래처(식당) 대상 여신 한도 상향 알림톡.
 *
 * 공급사가 /dashboard/customers "결제 설정" 모달에서 한도를 올려줄 때만 트리거된다
 * (하향은 발송하지 않음 — 통지할 만한 "좋은 소식"이 아니고, 공급사가 직접 안내하는
 * 게 자연스럽다고 판단). "여신 한도"라는 개념/용어 자체를 바이어는 모른다고 가정하고
 * 메시지에 쓰지 않는다 — 정확한 금액은 물론 "한도"라는 단어조차 노출하지 않고,
 * "외상 거래가 가능해졌다"는 결과와 미수금 정산 촉구만 안내한다.
 */
export async function sendCreditLimitIncreasedNotificationToRetailer(
  payload: CreditLimitIncreasedNotificationPayload
): Promise<NotificationResult> {
  const formattedMessage = `[외상 거래 안내]

${payload.retailerName} 담당자님, ${payload.wholesalerName}입니다.

지금 바로 외상 주문이 가능합니다.
미수금이 있으시면 빠른 정산 부탁드립니다.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "creditLimitIncreased",
    templateTitle: "외상 거래 가능 안내",
    formattedMessage,
    targetPhone: payload.retailerPhone,
  });
}

/**
 * 거래처(식당) 대상 '여신 한도 초과로 외상 주문 거절' 알림톡.
 *
 * sendCreditLimitExceededNotificationToWholesaler와 같은 이벤트에서 함께 트리거되지만
 * 수신자가 다르다(공급사 vs 바이어). 바이어 화면에서는 체크아웃 시도 중에만 에러
 * 문구가 보이고 그 외엔 알 방법이 없었던 문제를 보완한다. "여신 한도"라는 용어와
 * 정확한 한도/미수금 금액은 넣지 않고, 정산을 서두르지 않으면 발주가 계속 막힌다는
 * 행동 유도만 담는다.
 */
export async function sendCreditLimitExceededNotificationToRetailer(
  payload: CreditLimitExceededRetailerNotificationPayload
): Promise<NotificationResult> {
  const formattedMessage = `[외상 거래 제한 안내]

${payload.retailerName} 담당자님, ${payload.wholesalerName}입니다.

미수금이 있어 외상 주문이 접수되지 않았습니다.
미수금을 빠르게 정산해 주지 않으시면 앞으로도 발주가 계속 제한됩니다.
정산 후 다시 이용해주시기 바랍니다.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "creditLimitExceededRetailer",
    templateTitle: "외상 거래 제한 안내(고객)",
    formattedMessage,
    targetPhone: payload.retailerPhone,
  });
}

/**
 * 공급사(대표) 대상 '여신 한도 변경' 내부 알림톡.
 *
 * 거래처(식당)에게 가는 sendCreditLimitIncreasedNotificationToRetailer와는 별개의
 * 이벤트다 — 저건 상향일 때만, 이건 상향/하향 모두 "누가" 바꿨는지 대표에게
 * 통지하는 내부 감사용 알림이라 정확한 금액과 담당자 이름을 그대로 노출한다.
 */
export async function sendCreditLimitChangedNotificationToWholesaler(
  payload: CreditLimitChangedNotificationPayload
): Promise<NotificationResult> {
  const formattedMessage = `[여신 한도 변경 알림]

${payload.wholesalerName} 대표님, ${payload.actorName}님이 ${payload.retailerName}의 여신 한도를
${formatWon(payload.previousLimit)}에서 ${formatWon(payload.newLimit)}으로 변경하였습니다.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "creditLimitChangedWholesaler",
    templateTitle: "여신 한도 변경 알림",
    formattedMessage,
    targetPhone: payload.wholesalerPhone,
  });
}

/**
 * 공급사(대표) 대상 '거래처 정지 처리' 내부 알림톡.
 *
 * 누가/왜 정지시켰는지 대표에게 통지하는 내부 감사용 알림이라 정지 사유를
 * 그대로 노출한다. 거래처(고객) 본인에게 가는 sendRetailerBlockedNotificationToRetailer와는
 * 별개 이벤트/수신자다.
 */
export async function sendRetailerBlockedNotificationToWholesaler(
  payload: RetailerBlockedNotificationPayload
): Promise<NotificationResult> {
  const formattedMessage = `[거래처 정지 처리 알림]

${payload.wholesalerName} 대표님, ${payload.actorName}님이 ${payload.retailerName}와의 거래를 정지하였습니다.

■ 정지 사유: ${payload.reason}

거래처 관리 화면에서 상태를 확인하실 수 있습니다.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "retailerBlocked",
    templateTitle: "거래처 정지 처리 알림",
    formattedMessage,
    targetPhone: payload.wholesalerPhone,
  });
}

/**
 * 거래처(식당) 대상 '거래 제한' 알림톡.
 *
 * "여신 한도" 알림과 같은 원칙 — 정지 사유는 내부 사정(대금 미납 등)일 수 있어
 * 고객에게는 노출하지 않고, 발주가 제한됐다는 결과와 문의 유도만 담는다.
 */
export async function sendRetailerBlockedNotificationToRetailer(
  payload: RetailerStatusRetailerNotificationPayload
): Promise<NotificationResult> {
  const formattedMessage = `[거래 제한 안내]

${payload.retailerName} 담당자님, ${payload.wholesalerName}입니다.

현재 거래가 일시 제한되어 발주가 어렵습니다.
자세한 사항은 공급사에 직접 문의해주세요.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "retailerBlockedRetailer",
    templateTitle: "거래 제한 안내",
    formattedMessage,
    targetPhone: payload.retailerPhone,
  });
}

/**
 * 공급사(대표) 대상 '거래처 재개 처리' 내부 알림톡. 정지 해제 시 누가 처리했는지 통지한다.
 */
export async function sendRetailerResumedNotificationToWholesaler(
  payload: RetailerResumedNotificationPayload
): Promise<NotificationResult> {
  const formattedMessage = `[거래처 재개 처리 알림]

${payload.wholesalerName} 대표님, ${payload.actorName}님이 ${payload.retailerName}와의 거래를 재개하였습니다.

다시 발주가 가능한 상태입니다.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "retailerResumed",
    templateTitle: "거래처 재개 처리 알림",
    formattedMessage,
    targetPhone: payload.wholesalerPhone,
  });
}

/**
 * 거래처(식당) 대상 '거래 재개' 알림톡. 다시 발주 가능해졌다는 좋은 소식이라
 * 여신 한도 상향 안내와 같은 톤으로 별도 사유 없이 결과만 전달한다.
 */
export async function sendRetailerResumedNotificationToRetailer(
  payload: RetailerStatusRetailerNotificationPayload
): Promise<NotificationResult> {
  const formattedMessage = `[거래 재개 안내]

${payload.retailerName} 담당자님, ${payload.wholesalerName}입니다.

거래가 재개되어 다시 발주하실 수 있습니다.`;

  return dispatchAlimtalk({
    wholesalerId: payload.wholesalerId,
    templateKey: "retailerResumedRetailer",
    templateTitle: "거래 재개 안내",
    formattedMessage,
    targetPhone: payload.retailerPhone,
  });
}
