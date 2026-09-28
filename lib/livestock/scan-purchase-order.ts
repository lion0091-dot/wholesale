import type { createClient } from "@/lib/supabase/server";

/**
 * 입고 박스 하나가 발주서 판정에서 어떻게 됐는지(마이그레이션 142). 거래처를 실어 보낸 스캔에만 있다.
 * ASSIGNED 받았고 발주서 줄들에 채워짐(박스 하나가 여러 줄에 나뉠 수 있다) / UNLISTED_HELD 발주서에 없어 받아 두고 사무실 확인
 * / OVER_HELD 발주 수량을 넘어 받아 두고 사무실 확인 / REJECTED 받지 않음(재고에 없음, 거절 기록만 남음).
 */
export interface ScanPurchaseOrder {
  result: "ASSIGNED" | "UNLISTED_HELD" | "OVER_HELD" | "REJECTED";
  /** REJECTED일 때만: OVER = 발주 수량 초과, UNLISTED = 발주서에 없는 물건. */
  reason: "OVER" | "UNLISTED" | null;
  /** 받았으면 이 박스가 채운 줄들의 발주량 합, 거절이면 그 거래처 열린 발주 합계. */
  ordered: number | null;
  /** 거절이면 이 박스를 빼고 이미 받은 양, 받았으면 이 박스를 더한(채운 줄들의) 받은 양. */
  received: number | null;
  remaining: number | null;
  tolerance: number | null;
  /** OVER_HELD일 때만: 발주서 줄에 못 붙고 넘친 무게(kg). */
  excess: number | null;
  /** 이 박스로 발주서가 다 차서 자동 마감됐다. */
  orderClosed: boolean;
}

type Client = Awaited<ReturnType<typeof createClient>>;

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

/** DB 함수(judge_scan_purchase_order 등)가 돌려준 `po` JSON을 화면용 모양으로 바꾼다. 판정 대상이 아니면 null. */
export function scanPurchaseOrderFromDb(raw: unknown): ScanPurchaseOrder | null {
  if (!raw || typeof raw !== "object") return null;

  const row = raw as Record<string, unknown>;
  const result = row.result;

  if (result !== "ASSIGNED" && result !== "UNLISTED_HELD" && result !== "OVER_HELD" && result !== "REJECTED") {
    return null;
  }

  return {
    result,
    reason: row.reason === "OVER" || row.reason === "UNLISTED" ? row.reason : null,
    ordered: toNumberOrNull(row.ordered),
    received: toNumberOrNull(row.received),
    remaining: toNumberOrNull(row.remaining),
    tolerance: toNumberOrNull(row.tolerance),
    excess: toNumberOrNull(row.excess),
    orderClosed: Boolean(row.order_closed),
  };
}

/**
 * 박스가 지금 발주서 쪽에서 어떤 상태인지 DB에서 읽는다. 상품이 스캔 뒤에 정해지는 경로(자동 생성)는 DB 응답에
 * 판정이 실려 오지 않아서, 스캔을 끝낸 뒤 이 함수로 한 번 읽는다. 실패해도 입고 흐름을 막지 않고 null.
 */
export async function loadScanPurchaseOrder(supabase: Client, scanId: string): Promise<ScanPurchaseOrder | null> {
  try {
    const { data: scan } = await supabase
      .from("inbound_scans")
      .select("status, po_state, supplier_id, po_detail")
      .eq("id", scanId)
      .maybeSingle();

    if (!scan || !scan.supplier_id) return null;

    if (scan.status === "VOIDED") {
      const { data: rejection } = await supabase
        .from("inbound_rejections")
        .select("reason, detail")
        .eq("scan_id", scanId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!rejection) return null;

      const detail = (rejection.detail ?? {}) as Record<string, unknown>;

      return {
        result: "REJECTED",
        reason: rejection.reason === "OVER" ? "OVER" : "UNLISTED",
        ordered: toNumberOrNull(detail.ordered),
        received: toNumberOrNull(detail.received),
        remaining: null,
        tolerance: toNumberOrNull(detail.tolerance),
        excess: null,
        orderClosed: false,
      };
    }

    if (scan.po_state === "UNLISTED_HELD") {
      return { result: "UNLISTED_HELD", reason: null, ordered: null, received: null, remaining: null, tolerance: null, excess: null, orderClosed: false };
    }

    if (scan.po_state === "OVER_HELD") {
      const detail = (scan.po_detail ?? {}) as Record<string, unknown>;

      return {
        result: "OVER_HELD",
        reason: null,
        ordered: toNumberOrNull(detail.ordered),
        received: toNumberOrNull(detail.received),
        remaining: toNumberOrNull(detail.remaining),
        tolerance: toNumberOrNull(detail.tolerance),
        excess: toNumberOrNull(detail.excess),
        orderClosed: false,
      };
    }

    if (scan.po_state !== "ASSIGNED") return null;

    // 이 박스가 채운 줄들 — 발주량과 (그 줄들의) 받은 양은 DB 판정과 같은 계산(취소 제외 채움 무게의 합).
    const { data: filled } = await supabase
      .from("purchase_order_line_scans")
      .select("line_id, purchase_order_lines ( quantity, purchase_orders ( status, auto_closed_at ) )")
      .eq("scan_id", scanId);

    const touched = (filled ?? []) as unknown as Array<{ line_id: string; purchase_order_lines: unknown }>;

    if (touched.length === 0) return null;

    const { data: allFills } = await supabase
      .from("purchase_order_line_scans")
      .select("weight, inbound_scans ( status )")
      .in(
        "line_id",
        touched.map((row) => row.line_id)
      );

    let receivedTotal = 0;

    for (const row of (allFills ?? []) as unknown as Array<{ weight: number | string; inbound_scans: unknown }>) {
      const scanRaw = row.inbound_scans;
      const info = (Array.isArray(scanRaw) ? scanRaw[0] : scanRaw) as { status: string } | null | undefined;

      if (info && info.status !== "VOIDED") receivedTotal += Number(row.weight);
    }

    let ordered = 0;
    let orderClosed = false;

    for (const row of touched) {
      const line = (Array.isArray(row.purchase_order_lines) ? row.purchase_order_lines[0] : row.purchase_order_lines) as
        | { quantity: number | string; purchase_orders: unknown }
        | null
        | undefined;

      if (!line) continue;

      ordered += Number(line.quantity);

      const orderRaw = line.purchase_orders;
      const order = (Array.isArray(orderRaw) ? orderRaw[0] : orderRaw) as { status: string; auto_closed_at: string | null } | null | undefined;

      if (order?.status === "CLOSED" && order.auto_closed_at) orderClosed = true;
    }

    return {
      result: "ASSIGNED",
      reason: null,
      ordered,
      received: receivedTotal,
      remaining: Math.max(ordered - receivedTotal, 0),
      tolerance: null,
      excess: null,
      orderClosed,
    };
  } catch (error) {
    console.error("[inbound] 발주서 판정 조회 실패:", error instanceof Error ? error.message : error);

    return null;
  }
}

function formatKg(value: number): string {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 3 });
}

/** 거절 한 줄 요약 — 화면 카드와 "박스 나눠서 입고" 오류 문구가 같은 말을 쓴다. */
export function rejectionSummary(po: ScanPurchaseOrder): string {
  if (po.reason === "OVER") {
    const numbers =
      po.ordered !== null && po.received !== null
        ? ` (발주 ${formatKg(po.ordered)}kg 중 이미 ${formatKg(po.received)}kg 받았습니다)`
        : "";

    return `발주 수량을 넘어 받지 않았습니다${numbers}.`;
  }

  return "이 거래처의 전표에 없는 물건이라 받지 않았습니다.";
}

/** 보류(UNLISTED_HELD/OVER_HELD) 한 줄 요약 — "상품 지정" 경로도 직접 스캔 경로(inbound-scan-result.ts)와 같은 말을 쓴다. */
export function holdSummary(po: ScanPurchaseOrder): string {
  if (po.result === "OVER_HELD") {
    const numbers =
      po.ordered !== null && po.received !== null
        ? ` 발주 ${formatKg(po.ordered)}kg 중 ${formatKg(po.received)}kg 받았고` +
          (po.excess !== null && po.excess > 0 ? `, ${formatKg(po.excess)}kg는 전표에 붙지 않았습니다.` : ".")
        : "";

    return `발주 수량을 넘어 보류함에 들어갔습니다.${numbers} 사무실이 확인해서 정리합니다.`;
  }

  if (po.result === "UNLISTED_HELD") {
    return "이 거래처의 전표에 없는 물건이라 보류함에 들어갔습니다. 사무실이 확인해서 정리합니다.";
  }

  return "";
}

/** 한꺼번에 여러 박스가 거절됐을 때 — 하나씩 다 늘어놓지 않고 사유별 건수만 짧게. */
export function rejectionBatchSummary(reasons: ReadonlyArray<ScanPurchaseOrder["reason"]>): string {
  const overCount = reasons.filter((reason) => reason === "OVER").length;
  const unlistedCount = reasons.filter((reason) => reason === "UNLISTED").length;
  const parts = [
    overCount > 0 ? `발주 초과 ${overCount}건` : null,
    unlistedCount > 0 ? `목록에 없음 ${unlistedCount}건` : null,
  ].filter((part): part is string => part !== null);

  return `받지 않은 박스 ${reasons.length}건(${parts.join(", ")}) — 재고에 안 들어갔습니다.`;
}
