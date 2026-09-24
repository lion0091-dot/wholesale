import type { OrderStatus } from "@/types/database";

export interface StatusBadge {
  label: string;
  bg: string;
  color: string;
}

/** 주문 상태 배지 — 목록/상세/필터에서 공통 사용 */
export const ORDER_STATUS_BADGES: Record<OrderStatus, StatusBadge> = {
  pending: { label: "접수대기", bg: "#fef3c7", color: "#92400e" },
  awaiting_stock: { label: "확보 대기", bg: "#ffedd5", color: "#9a3412" },
  confirmed: { label: "확정", bg: "#dbeafe", color: "#1e40af" },
  shipping: { label: "배송중", bg: "#e0e7ff", color: "#3730a3" },
  delivered: { label: "완료", bg: "#dcfce7", color: "#166534" },
  cancel_requested: { label: "취소요청", bg: "#ffedd5", color: "#9a3412" },
  cancel_rejected: { label: "취소반려", bg: "#f1f5f9", color: "#475569" },
  cancelled: { label: "취소", bg: "#fee2e2", color: "#991b1b" },
};

/**
 * 진행중 탭 안에서의 상태 필터 순서 (전체 + 5개 상태).
 * 완료/취소는 별도 탭(HISTORICAL_STATUS_FILTERS)에서 다룬다.
 */
export const ACTIVE_STATUS_FILTERS: Array<OrderStatus | "all"> = [
  "all",
  "pending",
  "awaiting_stock",
  "confirmed",
  "cancel_requested",
  "shipping",
  "cancel_rejected",
];

/** 완료·취소 탭 안에서의 상태 필터 순서 (전체 + 2개 상태) */
export const HISTORICAL_STATUS_FILTERS: Array<OrderStatus | "all"> = [
  "all",
  "delivered",
  "cancelled",
];

/**
 * 배송완료/취소처럼 이미 끝난 "과거 기록" 상태. 매일 쌓이기만 하고 절대 줄지 않으므로
 * 주문 목록 화면에서 조회 구간(기본 최근 30일)으로 제한해서 불러온다.
 */
export const HISTORICAL_ORDER_STATUSES: OrderStatus[] = ["delivered", "cancelled"];

/**
 * 접수대기~취소반려처럼 아직 처리가 필요한 "진행 중" 상태. 처리되는 대로 곧 다음 상태로
 * 빠져나가서 애초에 무한정 쌓이지 않으므로 기간 제한 없이 항상 전체를 불러온다.
 */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  "pending",
  "awaiting_stock",
  "confirmed",
  "shipping",
  "cancel_requested",
  "cancel_rejected",
];

/**
 * 상태 전이 규칙 — 각 상태에서 이동 가능한 다음 상태 목록.
 *
 * DB에도 같은 표가 있다(enforce_order_status_transition, 20260930000107). 서버·RPC 내부·
 * super_admin 외의 세션이 테이블을 직접 UPDATE해도 같은 규칙을 탄다. 이 표를 고치면
 * 그 함수도 새 마이그레이션으로 같이 고칠 것.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["awaiting_stock", "confirmed", "cancel_requested", "cancelled"],
  // 물건이 들어와 재고가 생기면 확정으로 넘어간다. 확정 시점에 평소대로
  // 재고에서 차감되므로 별도 처리가 필요 없다.
  awaiting_stock: ["confirmed", "cancel_requested", "cancelled"],
  confirmed: ["shipping", "cancel_requested", "cancelled"],
  shipping: ["delivered"],
  delivered: [],
  // 취소요청은 공급사가 승인(cancelled) 또는 반려(cancel_rejected)로만 종결한다.
  cancel_requested: ["cancelled", "cancel_rejected"],
  // 반려되면 원래 진행 흐름으로 복귀한다.
  cancel_rejected: ["awaiting_stock", "confirmed", "shipping", "cancelled"],
  cancelled: [],
};

/**
 * 바이어(구매 회원)만 요청할 수 있는 상태.
 * 공급사 대시보드의 상태 변경 액션에서는 노출/허용하지 않는다.
 */
export const RETAILER_ONLY_STATUSES: OrderStatus[] = ["cancel_requested"];

/** 공급사(대시보드/서버 액션)가 직접 지정할 수 있는 상태인지 여부 */
export function isSupplierAssignableStatus(status: OrderStatus): boolean {
  return !RETAILER_ONLY_STATUSES.includes(status);
}

/**
 * 바이어가 취소 요청을 넣을 수 있는 상태.
 *
 * ORDER_STATUS_TRANSITIONS[status]에 'cancel_requested'가 있는 상태와는 다르다 —
 * 그 표는 pending/awaiting_stock/confirmed 셋 다 포함하지만, 실제로 취소 요청을
 * 써주는 곳(requestOrderCancelAction의 UPDATE 조건, DB 보안 트리거
 * enforce_order_cancel_authority)은 pending/confirmed 둘만 허용한다.
 * awaiting_stock까지 여기 포함시키면 버튼은 뜨는데 눌러도 항상 실패하는
 * 불일치가 생긴다(감사 결과 발견, 2026-09-23) — 그래서 실제 허용 상태를
 * 별도로 고정해서 화면과 백엔드를 맞춘다.
 */
const RETAILER_CANCELABLE_STATUSES: OrderStatus[] = ["pending", "confirmed"];

export function canRequestCancel(status: OrderStatus): boolean {
  return RETAILER_CANCELABLE_STATUSES.includes(status);
}

export interface StatusActionConfig {
  status: OrderStatus;
  label: string;
  /** 되돌릴 수 없는 처리는 확인창을 띄운다. */
  confirmMessage?: string;
  tone: "primary" | "info" | "success" | "danger";
}

export const ORDER_STATUS_ACTIONS: Record<OrderStatus, StatusActionConfig> = {
  pending: { status: "pending", label: "접수대기로 되돌리기", tone: "primary" },
  awaiting_stock: {
    status: "awaiting_stock",
    label: "확보 대기 (공급처 발주)",
    tone: "info",
  },
  confirmed: { status: "confirmed", label: "발주 확정 (접수 확인)", tone: "primary" },
  shipping: { status: "shipping", label: "출고 / 배송 시작", tone: "info" },
  delivered: { status: "delivered", label: "배송 완료 처리", tone: "success" },
  cancel_requested: {
    status: "cancel_requested",
    label: "발주 취소 요청",
    confirmMessage: "이 발주서의 취소를 요청하시겠습니까? 공급사 승인 후 취소가 확정됩니다.",
    tone: "danger",
  },
  cancel_rejected: {
    status: "cancel_rejected",
    label: "취소 요청 반려",
    confirmMessage: "취소 요청을 반려하시겠습니까? 발주는 기존 일정대로 진행됩니다.",
    tone: "primary",
  },
  cancelled: {
    status: "cancelled",
    label: "발주 취소",
    confirmMessage: "이 발주서를 취소 처리하시겠습니까? 취소 후에는 되돌릴 수 없습니다.",
    tone: "danger",
  },
};

// ====================================================================
// 알림톡 발송 상태
// ====================================================================

/**
 * 알림톡 발송 이력은 아직 별도 테이블에 적재하지 않는다.
 * 발송 트리거가 주문 접수/상태 변경 시점에 1:1로 걸려 있으므로
 * 현재 주문 상태에서 "마지막으로 발송된 알림톡"을 역산해 표시한다.
 * (lib/notifications/alimtalk.ts의 템플릿과 동일한 단계 구분)
 */
export interface AlimtalkStatus {
  /** 마지막 발송 템플릿 명 */
  label: string;
  /** 수신 대상 설명 */
  target: string;
  bg: string;
  color: string;
}

const ALIMTALK_BY_STATUS: Record<OrderStatus, AlimtalkStatus> = {
  // 확보 대기는 고객에게 따로 알리지 않는다. "주문은 받았는데 물건이 아직
  // 없다"를 그대로 보내면 불안만 키우고, 확정되면 어차피 확정 안내가 나간다.
  // 템플릿이 필요해지면 카카오 승인부터 받아야 한다.
  awaiting_stock: {
    label: "발송 없음 (확정 시 안내)",
    target: "—",
    bg: "#f1f5f9",
    color: "#475569",
  },
  pending: {
    label: "신규 발주 접수 알림",
    target: "공급사 담당자",
    bg: "#fef3c7",
    color: "#92400e",
  },
  confirmed: {
    label: "발주 확정 안내",
    target: "고객(소매)",
    bg: "#dbeafe",
    color: "#1e40af",
  },
  shipping: {
    label: "출고/배송 시작 안내",
    target: "고객(소매)",
    bg: "#e0e7ff",
    color: "#3730a3",
  },
  delivered: {
    label: "배송 완료 안내",
    target: "고객(소매)",
    bg: "#dcfce7",
    color: "#166534",
  },
  cancel_requested: {
    label: "주문 취소 요청 접수 안내",
    target: "공급사 담당자",
    bg: "#ffedd5",
    color: "#9a3412",
  },
  cancel_rejected: {
    label: "취소 요청 반려 안내",
    target: "고객(소매)",
    bg: "#f1f5f9",
    color: "#475569",
  },
  cancelled: {
    label: "주문 취소 안내",
    target: "고객(소매)",
    bg: "#fee2e2",
    color: "#991b1b",
  },
};

export function resolveAlimtalkStatus(status: OrderStatus): AlimtalkStatus {
  return ALIMTALK_BY_STATUS[status] ?? ALIMTALK_BY_STATUS.pending;
}

export function formatOrderedAt(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatWon(amount: number): string {
  return `${Math.round(Number(amount)).toLocaleString("ko-KR")}원`;
}
