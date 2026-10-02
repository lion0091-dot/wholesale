import type { SupabaseClient } from "@supabase/supabase-js";

/** list_stock_mismatches RPC(마이그레이션 215) 한 줄 — 상품 재고 또는 박스 잔량이 장부(원장)와 다른 항목. 대표만 받는다. */
export interface MismatchRow {
  kind: "product" | "box";
  targetId: string;
  label: string;
  unit: string;
  /** 지금 재고(상품) 또는 지금 잔량(박스) */
  currentValue: number;
  /** 장부(원장) 합계 */
  ledgerValue: number;
  diff: number;
  /** 박스일 때 입고 중량 — 실물 수량의 상한 */
  boxWeight: number | null;
  /** 박스 매입단가(모르면 null) — 재고 평가금액 영향 계산용 */
  unitPrice: number | null;
}

export interface RepairHistoryRow {
  id: string;
  kind: "product" | "box";
  targetLabel: string;
  basis: "LEDGER" | "ACTUAL";
  beforeCurrent: number;
  beforeLedger: number;
  afterValue: number;
  actualInput: number | null;
  valuationChange: number | null;
  reason: string;
  repairedByName: string;
  createdAt: string;
}

/** list_stock_movements RPC 한 줄 — 장부(원장)에 쌓인 입출고 기록 한 건. */
export interface MovementRow {
  createdAt: string;
  eventType: string;
  qtyDelta: number;
  sourceType: string;
  orderNumber: string | null;
  reason: string | null;
  actorName: string | null;
  boxTraceNo: string | null;
}

export type RepairBasis = "LEDGER" | "ACTUAL";

const EVENT_LABELS: Record<string, string> = {
  INBOUND: "입고",
  INBOUND_VOID: "입고 취소",
  OPENING_BALANCE: "기초 재고(원장 도입 전 수동 재고)",
  ORDER_OUT: "주문 출고(확정 시 자동 배정)",
  ORDER_RESTORE: "주문 취소 원복",
  OUTBOUND_ASSIGN: "출고 스캔 배정",
  OUTBOUND_UNASSIGN: "배정 정정(되돌림)",
  ADJUSTMENT: "재고 조정·보정",
  LOSS: "폐기·손실",
  SPLIT_OUT: "쪼개기(나감)",
  SPLIT_IN: "쪼개기(들어옴)",
};

export function movementLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType;
}

/** 근거 대조 결과 — 장부가 입출고 기록과 맞는지 보여주는 안내. */
export interface MovementEvidence {
  /** 보여준 기록이 100건 상한이라 합계 대조를 못 한 경우 */
  truncated: boolean;
  /** 기록 합계(= 장부 값과 같아야 한다) */
  sum: number;
  /** 사람이 읽을 경고들. 비어 있으면 근거가 맞는다. */
  warnings: string[];
}

export interface RepairPreview {
  /** 보정 뒤의 값(상품 재고 또는 박스 잔량). 계산할 수 없으면 null */
  after: number | null;
  /** 장부에 새로 쌓일 보정 기록의 수량(+는 늘림, −는 줄임). 장부 기준이면 0 */
  ledgerChange: number;
  /** 재고 평가금액이 얼마나 바뀌나(원, 줄면 음수). 박스 단위 + 매입단가를 알 때만 값이 있다 */
  valuationChange: number | null;
  /** 이 선택으로는 보정할 수 없는 이유(화면에 보여주고 버튼을 막는다). 없으면 null */
  error: string | null;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * "장부가 맞다"를 고르기 전에 장부가 입출고 기록과 맞는지 대조한다.
 *  - 기록 합계 = 장부 값 (보여준 기록만으로 합이 설명되는가)
 *  - 박스: 장부의 입고 합계 = 박스 입고 중량 (입고 기록 자체가 박스와 맞는가)
 */
export function checkMovementEvidence(row: MismatchRow, movements: MovementRow[]): MovementEvidence {
  const truncated = movements.length >= 100;
  const sum = round3(movements.reduce((total, movement) => total + movement.qtyDelta, 0));
  const warnings: string[] = [];

  if (!truncated && Math.abs(sum - row.ledgerValue) > 0.0005) {
    warnings.push(
      `기록을 모두 더하면 ${sum}${row.unit}인데 장부 값은 ${round3(row.ledgerValue)}${row.unit}이에요. 기록이 일부 빠져 있을 수 있어요.`
    );
  }

  if (row.kind === "box" && row.boxWeight !== null && !truncated) {
    const inbound = round3(
      movements.filter((movement) => movement.eventType === "INBOUND").reduce((total, movement) => total + movement.qtyDelta, 0)
    );

    if (Math.abs(inbound - row.boxWeight) > 0.0005) {
      warnings.push(
        `장부의 입고 기록은 ${inbound}${row.unit}인데 이 박스의 입고 중량은 ${round3(row.boxWeight)}${row.unit}이에요. 장부 자체가 입고와 다를 수 있으니 먼저 확인해 주세요.`
      );
    }
  }

  return { truncated, sum, warnings };
}

/**
 * 보정 미리보기 — 서버(repair_stock_mismatch)와 같은 규칙으로 "적용하면 어떻게 되나"를 계산한다. 아무것도 바꾸지 않는다.
 * 서버가 최종 판단하므로 여기 결과가 달라도 서버가 거부한다(이 함수는 화면 안내용).
 */
export function previewRepair(row: MismatchRow, basis: RepairBasis, actual: number | null): RepairPreview {
  let after: number;
  let ledgerChange = 0;

  if (basis === "LEDGER") {
    after = row.ledgerValue;

    if (row.kind === "box" && row.boxWeight !== null && (after < 0 || after > row.boxWeight)) {
      return {
        after: null,
        ledgerChange: 0,
        valuationChange: null,
        error: "장부 값이 이 박스의 입고 중량 범위를 벗어나서 장부 기준으로는 맞출 수 없어요. 실물 기준으로 보정해 주세요.",
      };
    }
  } else {
    if (actual === null || !Number.isFinite(actual)) {
      return { after: null, ledgerChange: 0, valuationChange: null, error: "실물 수량을 입력해 주세요." };
    }

    if (actual < 0) {
      return { after: null, ledgerChange: 0, valuationChange: null, error: "실물 수량은 0보다 작을 수 없어요." };
    }

    if (row.kind === "box" && row.boxWeight !== null && actual > row.boxWeight) {
      return {
        after: null,
        ledgerChange: 0,
        valuationChange: null,
        error: `이 박스는 ${round3(row.boxWeight)}${row.unit}만 입고됐어요. 그보다 많을 수 없습니다.`,
      };
    }

    after = round3(actual);
    ledgerChange = round3(after - row.ledgerValue);
  }

  const valuationChange =
    row.kind === "box" && row.unitPrice !== null ? Math.round((after - row.currentValue) * row.unitPrice) : null;

  return { after: round3(after), ledgerChange, valuationChange, error: null };
}

/** 로그인한 대표 세션으로 부른다 — RPC가 대표가 아니면 NOT_OWNER로 거부한다. 거부·오류는 null(화면이 안내 문구를 보여준다). */
export async function fetchStockMismatches(supabase: SupabaseClient): Promise<MismatchRow[] | null> {
  const { data, error } = await supabase.rpc("list_stock_mismatches");

  if (error || !Array.isArray(data)) return null;

  return (data as Array<Record<string, unknown>>).map((row) => ({
    kind: row.kind === "box" ? "box" : "product",
    targetId: String(row.target_id),
    label: String(row.label ?? ""),
    unit: String(row.unit ?? "kg"),
    currentValue: Number(row.current_value ?? 0),
    ledgerValue: Number(row.ledger_value ?? 0),
    diff: Number(row.diff ?? 0),
    boxWeight: row.box_weight === null || row.box_weight === undefined ? null : Number(row.box_weight),
    unitPrice: row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
  }));
}

export async function fetchStockMovements(supabase: SupabaseClient, kind: "product" | "box", id: string): Promise<MovementRow[] | null> {
  const { data, error } = await supabase.rpc("list_stock_movements", { p_kind: kind, p_id: id });

  if (error || !Array.isArray(data)) return null;

  // DB는 최근 순으로 100건을 주고, 화면은 오래된 순(시간 흐름)으로 보여준다.
  return (data as Array<Record<string, unknown>>)
    .map((row) => ({
      createdAt: String(row.created_at),
      eventType: String(row.event_type),
      qtyDelta: Number(row.qty_delta ?? 0),
      sourceType: String(row.source_type ?? ""),
      orderNumber: (row.order_number as string | null) ?? null,
      reason: (row.reason as string | null) ?? null,
      actorName: (row.actor_name as string | null) ?? null,
      boxTraceNo: (row.box_trace_no as string | null) ?? null,
    }))
    .reverse();
}

export async function fetchStockRepairs(supabase: SupabaseClient): Promise<RepairHistoryRow[]> {
  const { data, error } = await supabase.rpc("list_stock_repairs", { p_limit: 30 });

  if (error || !Array.isArray(data)) return [];

  return (data as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    kind: row.kind === "box" ? "box" : "product",
    targetLabel: String(row.target_label ?? ""),
    basis: row.basis === "ACTUAL" ? "ACTUAL" : "LEDGER",
    beforeCurrent: Number(row.before_current ?? 0),
    beforeLedger: Number(row.before_ledger ?? 0),
    afterValue: Number(row.after_value ?? 0),
    actualInput: row.actual_input === null || row.actual_input === undefined ? null : Number(row.actual_input),
    valuationChange: row.valuation_change === null || row.valuation_change === undefined ? null : Number(row.valuation_change),
    reason: String(row.reason ?? ""),
    repairedByName: String(row.repaired_by_name ?? ""),
    createdAt: String(row.created_at),
  }));
}
