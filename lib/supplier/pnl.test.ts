import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPnl, formatMonthLabel, formatQty, productGrossProfit, summarizePnl, type PnlMonthRow, type PnlProductRow } from "./pnl";

const month = (overrides: Partial<PnlMonthRow>): PnlMonthRow => ({
  monthStart: "2026-10-01",
  orderCount: 0,
  salesAmount: 0,
  costAmount: 0,
  unpricedItems: 0,
  lossAmount: 0,
  lossUnpricedEvents: 0,
  ...overrides,
});

describe("summarizePnl", () => {
  it("월별 줄을 합쳐 매출총이익·마진율·손실 반영 이익을 계산한다", () => {
    const totals = summarizePnl([
      month({ orderCount: 2, salesAmount: 410000, costAmount: 160000, lossAmount: 40000, unpricedItems: 2, lossUnpricedEvents: 1 }),
      month({ monthStart: "2026-09-01", orderCount: 1, salesAmount: 180000, costAmount: 120000 }),
    ]);

    expect(totals).toEqual({
      orderCount: 3,
      salesAmount: 590000,
      costAmount: 280000,
      grossProfit: 310000,
      marginRate: 52.5,
      lossAmount: 40000,
      profitAfterLoss: 270000,
      unpricedItems: 2,
      lossUnpricedEvents: 1,
    });
  });

  it("원가 미입력·금액 미상은 금액에 넣지 않고 개수로만 센다", () => {
    const totals = summarizePnl([month({ salesAmount: 100000, costAmount: 0, unpricedItems: 3, lossUnpricedEvents: 2 })]);

    expect(totals.costAmount).toBe(0);
    expect(totals.lossAmount).toBe(0);
    expect(totals.unpricedItems).toBe(3);
    expect(totals.lossUnpricedEvents).toBe(2);
  });

  it("매출이 없으면 마진율은 null(0으로 나누지 않는다)", () => {
    expect(summarizePnl([month({ lossAmount: 5000 })]).marginRate).toBeNull();
    expect(summarizePnl([]).marginRate).toBeNull();
  });

  it("원가가 매출보다 크면 음수(적자)", () => {
    const totals = summarizePnl([month({ salesAmount: 100000, costAmount: 130000 })]);

    expect(totals.grossProfit).toBe(-30000);
    expect(totals.marginRate).toBe(-30);
  });
});

describe("productGrossProfit / formatters", () => {
  const product: PnlProductRow = {
    productId: "p", productName: "한우 등심", unit: "kg", shippedQty: 6, salesAmount: 360000, costAmount: 160000,
    unpricedQty: 2, lossQty: 1, lossAmount: 40000, lossUnpricedQty: 0,
  };

  it("상품 한 줄의 매출총이익과 마진율", () => {
    expect(productGrossProfit(product)).toEqual({ grossProfit: 200000, marginRate: 55.6 });
    expect(productGrossProfit({ ...product, salesAmount: 0, costAmount: 0 }).marginRate).toBeNull();
  });

  it("월 이름·수량 표기", () => {
    expect(formatMonthLabel("2026-10-01")).toBe("2026년 10월");
    expect(formatMonthLabel("2026-01-01")).toBe("2026년 1월");
    expect(formatQty(2.5)).toBe("2.5");
    expect(formatQty(10)).toBe("10");
  });
});

describe("fetchPnl", () => {
  const client = (responses: Record<string, { data?: unknown; error?: unknown }>) => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const supabase = {
      rpc: async (name: string, args: unknown) => {
        calls.push({ name, args });
        const response = responses[name] ?? { data: [] };

        return { data: response.data ?? null, error: response.error ?? null };
      },
    } as unknown as SupabaseClient;

    return { supabase, calls };
  };

  it("월별·상품별 결과를 화면 모양으로 바꾼다", async () => {
    const { supabase, calls } = client({
      get_pnl_by_month: {
        data: [{ month_start: "2026-10-01", order_count: 2, sales_amount: "410000.00", cost_amount: "160000", unpriced_items: 2, loss_amount: "40000", loss_unpriced_events: 1 }],
      },
      get_pnl_by_product: {
        data: [{ product_id: "p1", product_name: "한우 등심", unit: "kg", shipped_qty: "6.000", sales_amount: "360000.00", cost_amount: "160000", unpriced_qty: "2.000", loss_qty: "1.000", loss_amount: "40000", loss_unpriced_qty: "0" }],
      },
    });

    const result = await fetchPnl(supabase, { from: "2026-10-01", to: "2026-10-02" });

    expect(result?.months[0]).toEqual({ monthStart: "2026-10-01", orderCount: 2, salesAmount: 410000, costAmount: 160000, unpricedItems: 2, lossAmount: 40000, lossUnpricedEvents: 1 });
    expect(result?.products[0]).toMatchObject({ productName: "한우 등심", shippedQty: 6, salesAmount: 360000, unpricedQty: 2, lossAmount: 40000 });
    expect(calls.map((call) => call.name).sort()).toEqual(["get_pnl_by_month", "get_pnl_by_product"]);
    expect(calls[0].args).toEqual({ p_from: "2026-10-01", p_to: "2026-10-02" });
  });

  it("DB가 거부하면(대표 아님·탭 꺼짐·기간 오류) null", async () => {
    const { supabase } = client({ get_pnl_by_month: { error: { message: "NOT_OWNER" } } });

    expect(await fetchPnl(supabase, { from: null, to: null })).toBeNull();
  });
});
