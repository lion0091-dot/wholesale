/**
 * 알림톡 템플릿 키 + 카카오 심사 신청용 기준 문구.
 *
 * 서버 전용 의존성(crypto, Supabase 등)을 포함하지 않으므로 클라이언트 컴포넌트
 * (app/dashboard/invites/alimtalk-settings-form.tsx)에서도 안전하게 import할 수 있다.
 * 실제 데이터 로딩/발송 로직은 서버 전용 모듈 lib/notifications/alimtalk.ts가 담당한다.
 * (lib/shop/catalog-types.ts / catalog.ts 분리와 같은 이유 — server-only 모듈을
 * "use client" 컴포넌트가 import하면 Node 전용 API가 클라이언트 번들에 끼어들어간다)
 */

export type AlimtalkTemplateKey =
  | "orderNew"
  | "cancelRequest"
  | "creditExceeded"
  | "receivablesReminder"
  | "creditLimitIncreased"
  | "creditLimitExceededRetailer";

/**
 * 공급사가 비즈뿌리오/카카오에 템플릿 심사를 신청할 때 그대로 제출해야 하는 기준 문구.
 * 실제 발송 시 dispatchAlimtalk가 보내는 formattedMessage와 구조가 같아야 승인 후
 * 발송이 카카오 서버 검증을 통과한다(변수 자리만 #{...}로 표시). 설정 화면이 이걸
 * 그대로 보여준다.
 */
export const ALIMTALK_TEMPLATE_REFERENCE_TEXT: Record<
  AlimtalkTemplateKey,
  { title: string; text: string }
> = {
  orderNew: {
    title: "신규 발주 접수 알림",
    text: `[신규 B2B 육류 발주 접수 알림]

#{공급사명} 대표님, 고객(소매)로부터 새로운 발주서가 접수되었습니다.

■ 발주 번호: #{발주번호}
■ 발주처(소매): #{바이어상호}
■ 발주 내역: #{발주내역}
■ 총 발주 금액: #{총금액}원
■ 배송지: #{배송지}
■ 배송 요청사항: #{배송요청사항}

도매업자 관리 대시보드에서 발주 상세 내역을 확인하시고 출고 준비를 진행해 주시기 바랍니다.`,
  },
  cancelRequest: {
    title: "주문 취소 요청 접수 알림",
    text: `[주문 취소 요청 접수 알림]

#{공급사명} 대표님, 고객(소매)가 접수된 발주서의 취소를 요청했습니다.

■ 발주 번호: #{발주번호}
■ 발주처(소매): #{바이어상호}
■ 발주 금액: #{발주금액}원
■ 요청 사유: #{취소사유}

아직 취소가 확정된 것은 아닙니다.
도매업자 관리 대시보드에서 출고 진행 상황을 확인하신 후 취소 승인 또는 반려를 처리해 주시기 바랍니다.`,
  },
  creditExceeded: {
    title: "여신 한도 초과 주문 거절 안내",
    text: `[여신 한도 초과 - 외상 주문 거절 안내]

#{공급사명} 대표님, #{바이어상호}에서 외상 주문을 시도했으나 여신 한도를
초과하여 주문이 접수되지 않았습니다.

■ 여신 한도: #{여신한도}원
■ 현재 미수금: #{현재미수금}원
■ 시도한 주문 금액: #{시도금액}원

미수금 정산 화면에서 정산 처리하거나 거래처 한도를 조정하시면 재주문이 가능합니다.`,
  },
  receivablesReminder: {
    title: "미수금 정산 리마인드",
    text: `[외상 거래 미수금 정산 안내]

#{바이어상호} 담당자님, #{공급사명}입니다.

■ 현재 미수금: #{현재미수금}원
■ #{정산기한안내}

빠른 시일 내 정산 부탁드립니다. 이미 정산을 완료하셨다면 안내를 확인해 주시기 바랍니다.`,
  },
  creditLimitIncreased: {
    title: "여신 한도 상향 - 주문 가능 안내(고객(소매)에게는 '한도' 미노출)",
    text: `[외상 거래 안내]

#{바이어상호} 담당자님, #{공급사명}입니다.

지금 바로 외상 주문이 가능합니다.
미수금이 있으시면 빠른 정산 부탁드립니다.`,
  },
  creditLimitExceededRetailer: {
    title: "여신 한도 초과 - 외상 주문 거절 안내(고객(소매)에게는 '한도' 미노출)",
    text: `[외상 거래 제한 안내]

#{바이어상호} 담당자님, #{공급사명}입니다.

미수금이 있어 외상 주문이 접수되지 않았습니다.
미수금을 빠르게 정산해 주지 않으시면 앞으로도 발주가 계속 제한됩니다.
정산 후 다시 이용해주시기 바랍니다.`,
  },
};
