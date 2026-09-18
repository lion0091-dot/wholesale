import type { OrderStatus } from "@/types/database";

export interface StatusBadge {
  label: string;
  bg: string;
  color: string;
}

/** 주문 상태 배지 — 목록/상세/필터에서 공통 사용 */
export const ORDER_STATUS_BADGES: Record<OrderStatus, StatusBadge> = {
  pending: { label: "접수대기", bg: "#fef3c7", color: "#92400e" },
  confirmed: { label: "확정", bg: "#dbeafe", color: "#1e40af" },
  shipping: { label: "배송중", bg: "#e0e7ff", color: "#3730a3" },
  delivered: { label: "완료", bg: "#dcfce7", color: "#166534" },
  cancel_requested: { label: "취소요청", bg: "#ffedd5", color: "#9a3412" },
  cancel_rejected: { label: "취소반려", bg: "#f1f5f9", color: "#475569" },
  cancelled: { label: "취소", bg: "#fee2e2", color: "#991b1b" },
};

/** 필터 탭 순서 (전체 + 7개 상태) */
export const ORDER_STATUS_FILTERS: Array<OrderStatus | "all"> = [
  "all",
  "pending",
  "confirmed",
  "cancel_requested",
  "shipping",
  "delivered",
  "cancel_rejected",
  "cancelled",
];

/** 상태 전이 규칙 — 각 상태에서 이동 가능한 다음 상태 목록 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["confirmed", "cancel_requested", "cancelled"],
  confirmed: ["shipping", "cancel_requested", "cancelled"],
  shipping: ["delivered"],
  delivered: [],
  // 취소요청은 공급사가 승인(cancelled) 또는 반려(cancel_rejected)로만 종결한다.
  cancel_requested: ["cancelled", "cancel_rejected"],
  // 반려되면 원래 진행 흐름으로 복귀한다.
  cancel_rejected: ["confirmed", "shipping", "cancelled"],
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

/** 바이어가 취소 요청을 넣을 수 있는 상태 (출고 이후에는 불가) */
export function canRequestCancel(status: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[status].includes("cancel_requested");
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
  confirmed: { status: "confirmed", label: "발주 확정 (접수 확인)", tone: "primary" },
  shipping: { status: "shipping", label: "출고 / 배송 시작", tone: "info" },
  delivered: { status: "delivered", label: "배송 완료 처리", tone: "success" },
  cancel_requested: {
    status: "cancel_requested",
    label: "주문 취소 요청",
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
    label: "주문 취소",
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

/**
 * 실제 카카오 알림톡 API 키가 설정되어 있는지 여부.
 * 미설정이면 발송이 콘솔 로그(mock)로만 처리되므로 UI에 '테스트 발송'으로 표기한다.
 */
export function isAlimtalkLiveChannel(): boolean {
  return Boolean(process.env.ALIMTALK_API_KEY && process.env.ALIMTALK_SENDER_PHONE);
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
