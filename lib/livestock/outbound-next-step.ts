/**
 * 출고 스캔 화면의 "다음 할 일" 안내 판단 로직 (입고 스캔의 지금 할 일 카드와 같은 원칙 — 업무를 몰라도 안내만 따라가면 끝까지 간다).
 * 화면이 이미 가진 값만 받아 지금 상태에서 할 일 하나를 고른다.
 */

export interface OutboundGuideInput {
  /** 목록에 있는 발주서 수. */
  orderCount: number;
  /** 아직 마감 안 된 발주서 수(다음에 고를 수 있는 것). */
  openOrderCount: number;
  /** 고른 발주서. 없으면 null. */
  selected: { status: string; finalized: boolean } | null;
  /** 상품별 진행. 진행 정보를 아직 못 불러왔으면 빈 배열. */
  progress: Array<{ orderedQty: number; scannedQty: number }>;
}

export type OutboundGuideKey =
  | "no-orders"
  | "pick-order"
  | "finalized"
  | "awaiting-stock"
  | "scan-first"
  | "scan-more"
  | "finalize";

export interface OutboundGuide {
  key: OutboundGuideKey;
  tone: "info" | "warn" | "done";
  title: string;
  detail: string;
  /** 같은 화면의 동작(예: 출고 마감) 또는 다른 화면 경로. */
  action?: { label: string; kind: "finalize" | "link"; href?: string };
}

export function pickOutboundGuide(input: OutboundGuideInput): OutboundGuide {
  if (input.orderCount === 0) {
    return {
      key: "no-orders",
      tone: "info",
      title: "출고할 발주서가 없습니다",
      detail: "발주 관리에서 접수된 발주서를 '확정'하면 여기에 나타납니다.",
      action: { label: "발주 관리로", kind: "link", href: "/dashboard/orders" },
    };
  }

  if (!input.selected) {
    return {
      key: "pick-order",
      tone: "info",
      title: "출고할 발주서를 고르세요",
      detail:
        input.openOrderCount > 0
          ? "위 목록에서 발주서를 고르면 가져올 박스가 나옵니다."
          : "모두 마감된 발주서입니다. 새 발주서가 확정되면 나타납니다.",
    };
  }

  if (input.selected.finalized) {
    return {
      key: "finalized",
      tone: "done",
      title: "이미 마감된 발주서입니다",
      detail:
        input.openOrderCount > 0
          ? "더 찍을 수 없습니다. 다음 발주서를 위 목록에서 고르세요. (소분 라벨은 인쇄할 수 있습니다)"
          : "더 찍을 수 없습니다. 새 발주서가 확정되면 나타납니다. (소분 라벨은 인쇄할 수 있습니다)",
    };
  }

  const allDone = input.progress.length > 0 && input.progress.every((row) => row.scannedQty >= row.orderedQty);
  const anyScanned = input.progress.some((row) => row.scannedQty > 0);

  if (input.selected.status === "awaiting_stock") {
    return {
      key: "awaiting-stock",
      tone: "warn",
      title: "재고 확보 대기 중인 발주서입니다",
      detail: "박스를 찍어 둘 수는 있지만, 마감은 재고가 채워져 발주서가 '확정'된 뒤에 할 수 있습니다.",
      action: { label: "발주 관리로", kind: "link", href: "/dashboard/orders" },
    };
  }

  if (allDone) {
    return {
      key: "finalize",
      tone: "done",
      title: "전부 채웠습니다 — 이제 출고 마감을 누르세요",
      detail: "마감하면 실제로 나간 중량으로 금액이 확정되고 배송 단계로 넘어갑니다.",
      action: { label: "출고 마감", kind: "finalize" },
    };
  }

  if (!anyScanned) {
    return {
      key: "scan-first",
      tone: "info",
      title: "가져올 박스를 찍으세요",
      detail:
        "창고에서 집은 박스의 바코드를 찍으면 그 박스가 나간 것으로 기록되고 거래명세서에 그 이력번호가 찍힙니다. 추천과 다른 박스를 찍어도 됩니다. 찍지 않고 마감하면 아래 '가져올 박스'(추천)가 나간 것으로 처리됩니다.",
    };
  }

  return {
    key: "scan-more",
    tone: "info",
    title: "남은 상품을 더 찍으세요",
    detail:
      "진행 표에서 덜 채운 상품을 찍습니다. 찍지 않은 상품은 추천 박스가 나간 것으로 처리됩니다. 더 찍을 것이 없으면 '출고 마감'을 누르세요 — 주문보다 적게 나갔으면 금액이 바뀌기 전에 확인 창이 뜹니다.",
    action: { label: "출고 마감", kind: "finalize" },
  };
}
