/**
 * 공급사 대시보드 맨 위 "지금 할 일" 카드의 판단 로직 — 가입 직후부터 첫 고객 초대까지.
 *
 * 입고(inbound-next-step.ts)·상품 관리(products-next-step.ts)와 같은 원칙: 동시에 여러 상황이어도 카드는
 * 하나만 보여 주고, 할 일이 없으면 null(카드 숨김). 문구는 짧게, 버튼은 그 일을 끝낼 수 있는 자리로 바로 보낸다.
 *
 * 왜 필요한가: 카카오 채널이 없어 승인 결과를 알림톡으로 못 보내고(2026-10-02), 국세청 대조가 "불일치"여도
 * 그 결과는 어드민만 봤다. 공급사가 화면에서 스스로 다음 할 일을 알 수 있어야 한다.
 *
 * 우선순위(위에서 먼저 걸리는 하나): 거절 → 일시정지 → (미승인) 사업자번호 미제출 → 개업일자 없음 → 국세청 불일치/미등록 →
 * 심사 중 → (승인) 승인 대기 손님 → 첫 고객 초대. 직원 계정(사업자 정보를 고칠 권한이 없는 사람)에게는 보이지 않는다.
 */

export type OnboardingSupplierStatus = "pending" | "active" | "suspended" | "rejected" | "closed";

export interface OnboardingNextStepInput {
  supplierStatus: OnboardingSupplierStatus | null;
  /** 운영팀 행정 승인 여부(profiles.is_verified) */
  isVerified: boolean;
  businessNumber: string | null;
  businessStartDate: string | null;
  /** 국세청 진위확인 결과: unchecked | match | mismatch | not_found | error (null이면 unchecked로 본다) */
  ntsStatus: string | null;
  /** 사업자등록증 사본을 올렸는가 */
  hasLicense: boolean;
  /** 거래 중(active) 고객 수 */
  activeCustomerCount: number;
  /** 승인 대기(pending_review) 손님 수 — 초대 번호와 안 맞아 공급사 승인을 기다리는 손님 */
  pendingReviewCount: number;
  /** 사업자 정보 제출·고객 승인을 할 수 있는 사람(대표·매니저)인가 */
  canManage: boolean;
}

export type OnboardingNextStepKey =
  | "rejected"
  | "suspended"
  | "submit-number"
  | "submit-start-date"
  | "fix-business-info"
  | "under-review"
  | "pending-customers"
  | "invite-first-customer";

export interface OnboardingNextStep {
  key: OnboardingNextStepKey;
  title: string;
  detail: string;
  /** null이면 버튼 없이 안내만 한다(운영팀에 문의해야 하는 경우 등) */
  button: { label: string; href: string } | null;
}

export const ONBOARDING_PATHS = {
  businessInfo: "/dashboard/invites#business-info",
  businessLicense: "/dashboard/invites#business-license",
  inviteLink: "/dashboard#invite-link",
  pendingCustomers: "/dashboard/customers?status=pending_review",
} as const;

export function pickOnboardingNextStep(input: OnboardingNextStepInput): OnboardingNextStep | null {
  if (!input.canManage) return null;

  const status = input.supplierStatus;

  if (status === "closed" || status === null) return null;

  if (status === "rejected") {
    return {
      key: "rejected",
      title: "입점 심사가 거절되었습니다",
      detail: "사업자 정보를 사업자등록증과 비교해 고친 뒤, 운영팀에 재심사를 요청하세요.",
      button: { label: "사업자 정보 확인하기", href: ONBOARDING_PATHS.businessInfo },
    };
  }

  if (status === "suspended") {
    return {
      key: "suspended",
      title: "이용이 일시정지되었습니다",
      detail: "구독료 미납 또는 운영 정책 때문입니다. 플랫폼 운영팀에 문의하면 해제됩니다.",
      button: null,
    };
  }

  const approved = status === "active" && input.isVerified;

  if (!approved) {
    if (!input.businessNumber) {
      return {
        key: "submit-number",
        title: "사업자 정보를 제출하면 승인 심사가 시작됩니다",
        detail: "사업자등록번호와 개업일자를 넣고 [심사 요청]을 누르세요. 승인 전에도 상품 등록과 주문 접수는 쓸 수 있습니다.",
        button: { label: "사업자 정보 입력하기", href: ONBOARDING_PATHS.businessInfo },
      };
    }

    if (!input.businessStartDate) {
      return {
        key: "submit-start-date",
        title: "개업일자도 제출해야 심사할 수 있습니다",
        detail: "사업자등록증의 \"개업연월일\"을 넣고 [심사 요청]을 다시 누르세요.",
        button: { label: "개업일자 입력하기", href: ONBOARDING_PATHS.businessInfo },
      };
    }

    if (input.ntsStatus === "mismatch" || input.ntsStatus === "not_found") {
      return {
        key: "fix-business-info",
        title: "사업자 정보가 국세청 자료와 맞지 않습니다",
        detail: "사업자등록증과 비교해 사업자번호·대표자명·개업일자를 고친 뒤 [심사 요청]을 다시 누르세요.",
        button: { label: "사업자 정보 고치기", href: ONBOARDING_PATHS.businessInfo },
      };
    }

    return {
      key: "under-review",
      title: "심사 중입니다",
      detail: input.hasLicense
        ? "운영팀이 확인하고 있습니다. 승인되면 이 칸이 바뀌고 고객 초대가 열립니다. 지금 따로 할 일은 없습니다."
        : "운영팀이 확인하고 있습니다. 사업자등록증 사본을 올려 두면 더 빨리 확인할 수 있습니다(선택).",
      button: input.hasLicense ? null : { label: "사업자등록증 사본 올리기", href: ONBOARDING_PATHS.businessLicense },
    };
  }

  if (input.pendingReviewCount > 0) {
    return {
      key: "pending-customers",
      title: `승인을 기다리는 손님이 ${input.pendingReviewCount}명 있습니다`,
      detail: "초대한 전화번호와 달라 자동으로 연결되지 않은 손님입니다. 아는 손님이면 승인하세요.",
      button: { label: "손님 확인하기", href: ONBOARDING_PATHS.pendingCustomers },
    };
  }

  if (input.activeCustomerCount === 0) {
    return {
      key: "invite-first-customer",
      title: "승인되었습니다. 첫 고객을 초대하세요",
      detail: "손님 전화번호를 넣고 [카톡 초대링크 복사]를 눌러 카카오톡으로 보내세요.",
      button: { label: "초대 링크 만들기", href: ONBOARDING_PATHS.inviteLink },
    };
  }

  return null;
}
