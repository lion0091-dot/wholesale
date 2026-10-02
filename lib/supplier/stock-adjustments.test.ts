import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchStockAdjustments, formatAdjustQty, kindLabel, parseKindFilter } from "./stock-adjustments";

function fakeClient(responses: Record<string, { data?: unknown; error?: unknown }>) {
  const calls: Array<{ name: string; args: unknown }> = [];

  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      const response = responses[name] ?? { data: [] };

      return { data: response.data ?? null, error: response.error ?? null };
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

describe("parseKindFilter / kindLabel / formatAdjustQty", () => {
  it("알려진 종류만 통과시키고 나머지는 null(전체)", () => {
    expect(parseKindFilter("LOSS")).toBe("LOSS");
    expect(parseKindFilter("ADJUSTMENT")).toBe("ADJUSTMENT");
    expect(parseKindFilter("INBOUND")).toBeNull();
    expect(parseKindFilter(undefined)).toBeNull();
    expect(parseKindFilter("")).toBeNull();
  });

  it("종류 이름", () => {
    expect(kindLabel("LOSS")).toBe("폐기·손실");
    expect(kindLabel("ADJUSTMENT")).toBe("조정·보정");
  });

  it("수량은 g 단위까지, 뒤쪽 0은 없앤다", () => {
    expect(formatAdjustQty(2.5)).toBe("2.5");
    expect(formatAdjustQty(-1)).toBe("-1");
    expect(formatAdjustQty(0.1 + 0.2)).toBe("0.3");
    expect(formatAdjustQty(1.0004)).toBe("1");
  });
});

describe("fetchStockAdjustments", () => {
  it("목록과 단위별 합계를 읽어 화면 모양으로 바꾼다 (금액 없음은 0이 아니라 null)", async () => {
    const { client, calls } = fakeClient({
      list_stock_adjustments: {
        data: [
          {
            ledger_id: "l1", created_at: "2026-10-02T01:00:00Z", kind: "LOSS", reason: "박스 폐기(파손)",
            product_id: "p1", product_name: "한우 등심", unit: "kg", qty_delta: "-2.500",
            trace_no: "089900000001", unit_price: "40000.00", loss_amount: "100000", by_name: "대표", total_count: 2,
          },
          {
            ledger_id: "l2", created_at: "2026-10-02T00:00:00Z", kind: "ADJUSTMENT", reason: "반품 입고",
            product_id: "p1", product_name: "한우 등심", unit: "kg", qty_delta: "2.000",
            trace_no: null, unit_price: null, loss_amount: null, by_name: "대표", total_count: 2,
          },
        ],
      },
      summarize_stock_adjustments: {
        data: [
          { unit: "kg", event_count: 2, loss_qty: "2.500", loss_amount: "100000", loss_unpriced_qty: "0", adjust_in_qty: "2.000", adjust_out_qty: "0" },
        ],
      },
    });

    const result = await fetchStockAdjustments(client, { from: "2026-10-01", to: "2026-10-02", kind: null });

    expect(result).not.toBeNull();
    expect(result?.totalCount).toBe(2);
    expect(result?.rows[0]).toMatchObject({ kind: "LOSS", qtyDelta: -2.5, lossAmount: 100000, unitPrice: 40000, traceNo: "089900000001" });
    expect(result?.rows[1]).toMatchObject({ kind: "ADJUSTMENT", lossAmount: null, unitPrice: null, traceNo: null });
    expect(result?.summary).toEqual([
      { unit: "kg", eventCount: 2, lossQty: 2.5, lossAmount: 100000, lossUnpricedQty: 0, adjustInQty: 2, adjustOutQty: 0 },
    ]);
    expect(calls.map((call) => call.name).sort()).toEqual(["list_stock_adjustments", "summarize_stock_adjustments"]);
    expect(calls.find((call) => call.name === "list_stock_adjustments")?.args).toEqual({
      p_from: "2026-10-01", p_to: "2026-10-02", p_kind: null, p_limit: 200,
    });
  });

  it("기록이 없으면 빈 목록(null이 아니다)", async () => {
    const { client } = fakeClient({});
    const result = await fetchStockAdjustments(client, { from: null, to: null, kind: "LOSS" });

    expect(result).toEqual({ rows: [], totalCount: 0, summary: [] });
  });

  it("DB가 거부하면(대표 아님·탭 꺼짐) null", async () => {
    const { client } = fakeClient({ list_stock_adjustments: { error: { message: "NOT_OWNER" } } });

    expect(await fetchStockAdjustments(client, { from: null, to: null, kind: null })).toBeNull();
  });
});
