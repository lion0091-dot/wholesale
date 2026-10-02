/**
 * 고객 관리 화면 맨 위 "지금 할 일" 카드의 판단 로직(순수 함수).
 *
 * 다른 카드와 같은 원칙(하나만 강조, 할 일 없으면 숨김). 고객 관리에서 사장님·매니저가 해야 할 일:
 * 초대 번호와 안 맞아 승인을 기다리는 손님을 승인/거절 → (거래처가 아직 없으면) 첫 고객 초대 →
 * 상호·배송지가 비어 있는 손님 확인.
 */

export interface CustomersNextStepInput {
  /** 손님 승인·거래중지는 사장님·매니저만 한다. 직원에게는 카드를 안 보인다. */
  canManage: boolean;
  /** 고객 초대장 발부가 열려 있는가(승인된 공급사) */
  canIssueInvite: boolean;
  /** 거래 중(active) 손님 수 */
  activeCount: number;
  /** 승인 대기(pending_review) 손님 수 */
  pendingReviewCount: number;
  /** 상호 또는 배송지가 아직 자리표시자인 손님 수 */
  incompleteProfileCount: number;
  /** 승인 대기 손님 중 가장 먼저 처리할 손님 id */
  firstPendingId: string | null;
}

export type CustomersNextStepAction =
  | { kind: "review"; customerId: string }
  | { kind: "link"; href: string }
  | { kind: "none" };

export interface CustomersNextStep {
  key: "approve-pending" | "invite-first" | "wait-approval" | "incomplete-profile";
  title: string;
  detail: string;
  buttonLabel: string | null;
  action: CustomersNextStepAction;
}

export function pickCustomersNextStep(input: CustomersNextStepInput): CustomersNextStep | null {
  if (!input.canManage) return null;

  if (input.pendingReviewCount > 0 && input.firstPendingId) {
    return {
      key: "approve-pending",
      title: `승인을 기다리는 손님이 ${input.pendingReviewCount}명 있습니다`,
      detail: "초대한 전화번호와 달라 자동으로 연결되지 않은 손님입니다. 아는 손님이면 승인하고, 아니면 사유를 적어 거절하세요. 승인 전에는 손님이 상품과 단가를 볼 수 없습니다.",
      buttonLabel: "첫 손님 승인 검토",
      action: { kind: "review", customerId: input.firstPendingId },
    };
  }

  if (input.activeCount === 0 && input.pendingReviewCount === 0) {
    return input.canIssueInvite
      ? {
          key: "invite-first",
          title: "아직 거래 중인 고객이 없습니다. 첫 고객을 초대하세요",
          detail: "대시보드에서 손님 전화번호를 넣고 [카톡 초대링크 복사]를 눌러 카카오톡으로 보내세요.",
          buttonLabel: "초대 링크 만들기",
          action: { kind: "link", href: "/dashboard#invite-link" },
        }
      : {
          key: "wait-approval",
          title: "승인되면 고객을 초대할 수 있습니다",
          detail: "사업자 정보를 제출하고 운영팀 승인을 받으면 초대 링크가 열립니다.",
          buttonLabel: "사업자 정보 확인하기",
          action: { kind: "link", href: "/dashboard/invites#business-info" },
        };
  }

  if (input.incompleteProfileCount > 0) {
    return {
      key: "incomplete-profile",
      title: `상호·배송지가 아직 비어 있는 손님이 ${input.incompleteProfileCount}명 있습니다`,
      detail: "카카오로 막 가입한 손님입니다. 주문·배송 전에 손님에게 상호와 배송지를 확인하세요. 목록에서 \"정보 미입력\" 표시가 있는 손님입니다.",
      buttonLabel: null,
      action: { kind: "none" },
    };
  }

  return null;
}
