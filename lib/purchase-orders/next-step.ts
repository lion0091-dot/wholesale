/**
 * 전표관리·보류함 화면 맨 위 "지금 할 일" 카드의 판단 로직(순수 함수).
 *
 * 다른 "지금 할 일" 카드(입고·상품 관리·공급사 대시보드·어드민)와 같은 원칙: 하나만 강조하고, 할 일이 없으면
 * 없다고 말한다. 전표는 재고를 바꾸지 않는 장부라서(재고는 입고 스캔뿐) 카드도 "장부를 정리하는 일"만 안내한다.
 *
 * 전표관리 우선순위: 거래처 없음(입고 스캔도 못 시작함) → 전표 없음 → 도착 예정일이 지난 진행 중 전표 → 보류함에 정리할 물건.
 */

export interface PurchaseOrdersNextStepInput {
  /** 사장님·매니저만 전표를 쓰고 거래처를 등록한다. 직원에게는 카드를 안 보인다. */
  canManage: boolean;
  /** 사용 중인(is_active) 거래처 수 */
  activeSupplierCount: number;
  /** 지금까지 작성한 전표 수(상태 무관) */
  orderCount: number;
  /** 도착 예정일이 오늘보다 앞인데 아직 진행 중(OPEN)인 전표 — 오래된 도착 예정일부터 */
  overdueOrders: Array<{ id: string; supplierName: string; expectedOn: string }>;
  /** 보류함(전표에 없음/수량 초과로 받아 둔 물건) 대기 수 */
  heldCount: number;
}

export type PurchaseOrdersNextStepAction =
  | { kind: "open-suppliers" }
  | { kind: "open-form" }
  | { kind: "scroll"; targetId: string }
  | { kind: "link"; href: string };

export interface PurchaseOrdersNextStep {
  key: "no-supplier" | "no-order" | "overdue" | "holds";
  title: string;
  detail: string;
  buttonLabel: string;
  action: PurchaseOrdersNextStepAction;
}

export const HOLDS_PATH = "/dashboard/inbound/holds";

export function pickPurchaseOrdersNextStep(input: PurchaseOrdersNextStepInput): PurchaseOrdersNextStep | null {
  if (!input.canManage) return null;

  if (input.activeSupplierCount === 0) {
    return {
      key: "no-supplier",
      title: "먼저 거래처(공급처)를 등록하세요",
      detail: "등록한 거래처는 전표와 입고 스캔의 \"지금 온 거래처\"에 똑같이 나옵니다. 등록 전에는 입고 스캔을 시작할 수 없습니다.",
      buttonLabel: "거래처 등록하기",
      action: { kind: "open-suppliers" },
    };
  }

  if (input.orderCount === 0) {
    return {
      key: "no-order",
      title: "첫 전표를 작성하세요",
      detail: "공급처에 주문할 품목과 수량을 적어 두면, 현장이 박스를 찍을 때 자동으로 맞춰 봅니다. 안 써도 입고 스캔은 됩니다.",
      buttonLabel: "+ 새 전표 작성",
      action: { kind: "open-form" },
    };
  }

  if (input.overdueOrders.length > 0) {
    const first = input.overdueOrders[0];
    const rest = input.overdueOrders.length - 1;

    return {
      key: "overdue",
      title: `도착 예정일이 지난 전표가 ${input.overdueOrders.length}건 있습니다`,
      detail: `${first.supplierName} ${first.expectedOn} 도착 예정${rest > 0 ? ` 외 ${rest}건` : ""}. 공급처에 확인하세요. 더 안 오기로 했으면 그 전표의 [발주강제종결]을 누르세요.`,
      buttonLabel: "해당 전표 보기",
      action: { kind: "scroll", targetId: `po-${first.id}` },
    };
  }

  if (input.heldCount > 0) {
    return {
      key: "holds",
      title: `보류함에 정리할 물건이 ${input.heldCount}건 있습니다`,
      detail: "전표에 없거나 수량보다 많이 온 물건입니다. 이미 재고에는 들어가 팔 수 있습니다. 확인하고 전표를 사후에 만들어 정리하세요.",
      buttonLabel: "보류함으로 가기",
      action: { kind: "link", href: HOLDS_PATH },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------------------------

export interface HoldsNextStepInput {
  canManage: boolean;
  /** 정리할(대기 중) 보류 물건 수 */
  holdCount: number;
  /** 받지 않고 기록만 남긴 물건 수(읽기 전용 목록) */
  rejectionCount: number;
  /** 맨 위로 보낼 첫 건의 scanId (없으면 null) */
  firstScanId: string | null;
  /** 화면 목록이 조회 상한에서 잘렸는가 — 그러면 개수를 "N건 이상"으로 말한다 */
  capped?: boolean;
}

export interface HoldsNextStep {
  key: "clear" | "manage" | "wait-manager";
  title: string;
  detail: string;
  /** null이면 버튼 없이 안내만 */
  button: { label: string; href: string } | null;
}

export function pickHoldsNextStep(input: HoldsNextStepInput): HoldsNextStep {
  const countText = `${input.holdCount}건${input.capped ? " 이상" : ""}`;

  if (input.holdCount === 0) {
    return {
      key: "clear",
      title: "정리할 물건이 없습니다",
      detail: input.rejectionCount > 0
        ? `보류된 물건은 모두 정리됐습니다. 받지 않고 기록만 남긴 물건 ${input.rejectionCount}건은 아래에서 읽기 전용으로 볼 수 있습니다.`
        : "전표에 없거나 초과로 온 물건이 없습니다. 할 일이 없습니다.",
      button: null,
    };
  }

  if (!input.canManage) {
    return {
      key: "wait-manager",
      title: `정리할 물건이 ${countText} 있습니다`,
      detail: "사장님·매니저가 정리합니다. 직원은 볼 수만 있습니다. 재고에는 이미 들어가 팔 수 있습니다.",
      button: null,
    };
  }

  return {
    key: "manage",
    title: `정리할 물건이 ${countText} 있습니다`,
    detail: "공급처·품목·무게를 확인하고 [전표 추가 생성]을 누르면 전표가 만들어지고 정리됩니다. 이미 재고에는 들어가 팔 수 있습니다.",
    button: input.firstScanId ? { label: "첫 건으로 가기", href: `#hold-${input.firstScanId}` } : null,
  };
}
