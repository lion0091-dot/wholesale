/**
 * 입고 ↔ 발주서 연결(마이그레이션 142) — 서버 액션을 통해 끝까지: 거래처를 싣고 찍으면 발주서 줄에 붙고, 초과·없는 물건은 재고에 안 남기고 거절 기록만 남는다.
 * 판정 규칙의 세부(허용 오차·후보 여럿·자동 마감/재개)는 scripts/db-test-purchase-order-receiving.sql이 한다 — 여기는 액션·화면 결과와의 이음새를 본다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";
import {
  recordScanAction,
  recordSplitScansAction,
  replaceScanTraceNoAction,
  resolveMappingAction,
  type ReplaceTraceResult,
  type ScanResult,
} from "@/app/dashboard/inbound/actions";

let world: World;

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

beforeEach(async () => {
  await actAs(world.users.ownerA);
});

async function newSupplier(name: string): Promise<string> {
  const { data, error } = await adminClient()
    .from("suppliers")
    .insert({ wholesaler_id: world.wholesalerA, name: `${name}-${world.runId}` })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  return data.id as string;
}

async function newPurchaseOrder(supplierId: string, lines: Array<{ product: WorldProduct; quantity: number }>): Promise<string> {
  const admin = adminClient();
  const { data: order, error } = await admin
    .from("purchase_orders")
    .insert({ wholesaler_id: world.wholesalerA, supplier_id: supplierId, supplier_name: "테스트", ordered_on: new Date().toISOString().slice(0, 10), status: "OPEN" })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  const { error: lineError } = await admin.from("purchase_order_lines").insert(
    lines.map((line, index) => ({
      purchase_order_id: order.id,
      wholesaler_id: world.wholesalerA,
      line_no: index + 1,
      category: "돼지",
      origin: "국내산",
      quantity: line.quantity,
      unit: "kg",
      product_id: line.product.id,
    }))
  );

  if (lineError) throw new Error(lineError.message);

  return order.id as string;
}

async function stockOf(productId: string): Promise<number> {
  const { data } = await adminClient().from("products").select("stock_quantity").eq("id", productId).single();

  return Number(data?.stock_quantity);
}

async function scanRow(traceNo: string) {
  const { data } = await adminClient()
    .from("inbound_scans")
    .select("id, status, supplier_id, po_state")
    .eq("wholesaler_id", world.wholesalerA)
    .eq("trace_no", traceNo)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return data as { id: string; status: string; supplier_id: string | null; po_state: string | null };
}

async function scan(traceNo: string, weight: number, extra: Partial<Parameters<typeof recordScanAction>[0]> = {}) {
  await world.seedTrace(traceNo, { part: "등심" });
  const result = await recordScanAction({ traceNo, weight, scanType: "MANUAL", ...extra });

  expect(result.success, result.error).toBe(true);

  return result.data as ScanResult;
}

describe("입고 스캔 액션 — 거래처를 싣고 찍기", () => {
  it("발주서 줄에 붙으면 받은 양·남은 양이 응답에 실리고, 다 채우면 발주서가 자동 마감된다. 넘치는 박스는 재고에 안 남고 거절 기록만 남는다", async () => {
    const supplierId = await newSupplier("가");
    const product = await world.createProduct({ stock_quantity: 0 });
    const orderId = await newPurchaseOrder(supplierId, [{ product, quantity: 30 }]);

    const first = await scan(world.newTraceNo(), 20, { productId: product.id, supplierId });

    expect(first.status).toBe("NORMAL");
    expect(first.po).toMatchObject({ result: "ASSIGNED", ordered: 30, received: 20, remaining: 10, orderClosed: false });
    expect(await stockOf(product.id)).toBe(20);

    const overTrace = world.newTraceNo();
    const over = await scan(overTrace, 15, { productId: product.id, supplierId });

    expect(over.status).toBe("REJECTED");
    expect(over.po).toMatchObject({ result: "REJECTED", reason: "OVER", ordered: 30, received: 20 });
    expect(await stockOf(product.id)).toBe(20);
    expect((await scanRow(overTrace)).status).toBe("VOIDED");

    const { data: rejections } = await adminClient().from("inbound_rejections").select("reason, weight").eq("trace_no", overTrace);

    expect(rejections).toEqual([{ reason: "OVER", weight: 15 }]);

    const last = await scan(world.newTraceNo(), 10, { productId: product.id, supplierId });

    expect(last.po).toMatchObject({ result: "ASSIGNED", remaining: 0, orderClosed: true });

    const { data: order } = await adminClient().from("purchase_orders").select("status, auto_closed_at").eq("id", orderId).single();

    expect(order?.status).toBe("CLOSED");
    expect(order?.auto_closed_at).not.toBeNull();
  });

  it("입고 기준이 '초과도 일단 받기'면 넘치는 박스가 재고에 들어가 팔 수 있고, 발주서엔 남은 자리만 채워지며 거절 기록은 안 남는다", async () => {
    const supplierId = await newSupplier("초과보류");
    const product = await world.createProduct({ stock_quantity: 0 });
    const orderId = await newPurchaseOrder(supplierId, [{ product, quantity: 30 }]);

    await adminClient().from("receiving_policies").upsert({ wholesaler_id: world.wholesalerA, over_item_policy: "HOLD" }, { onConflict: "wholesaler_id" });

    try {
      const first = await scan(world.newTraceNo(), 20, { productId: product.id, supplierId });

      expect(first.po).toMatchObject({ result: "ASSIGNED", remaining: 10 });

      const overTrace = world.newTraceNo();
      const over = await scan(overTrace, 15, { productId: product.id, supplierId });

      expect(over.status).toBe("NORMAL");
      expect(over.po).toMatchObject({ result: "OVER_HELD" });
      expect(await stockOf(product.id)).toBe(35);

      const row = await scanRow(overTrace);

      expect(row).toMatchObject({ status: "NORMAL", po_state: "OVER_HELD" });

      const { data: fills } = await adminClient().from("purchase_order_line_scans").select("weight").eq("scan_id", row.id);

      expect(fills!.map((fill) => Number(fill.weight))).toEqual([10]);

      const { data: rejections } = await adminClient().from("inbound_rejections").select("id").eq("trace_no", overTrace);

      expect(rejections).toEqual([]);

      const { data: order } = await adminClient().from("purchase_orders").select("status").eq("id", orderId).single();

      expect(order?.status).toBe("CLOSED");
    } finally {
      await adminClient().from("receiving_policies").delete().eq("wholesaler_id", world.wholesalerA);
    }
  });

  it("거래처를 안 실으면 판정 없이 예전처럼 받는다", async () => {
    const product = await world.createProduct({ stock_quantity: 0 });
    const result = await scan(world.newTraceNo(), 500, { productId: product.id });

    expect(result.status).toBe("NORMAL");
    expect(result.po).toBeNull();
    expect(await stockOf(product.id)).toBe(500);
  });

  it("남의 업체 거래처 ID를 실으면 거래처를 찾을 수 없다고 알린다", async () => {
    const product = await world.createProduct({ stock_quantity: 0 });
    const trace = world.newTraceNo();

    await world.seedTrace(trace, { part: "등심" });

    const result = await recordScanAction({
      traceNo: trace,
      weight: 5,
      scanType: "MANUAL",
      productId: product.id,
      supplierId: "00000000-0000-0000-0000-000000000000",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("거래처를 찾을 수 없습니다");
  });

  it("상품이 스캔 뒤에 자동으로 정해지는 박스는 발주서에 맞는 상품이 하나일 때만 받는다 — 하나도 없으면 새 상품을 만들지 않고 보관한다(177)", async () => {
    const supplierId = await newSupplier("나");
    const other = await world.createProduct({ stock_quantity: 0 });

    await newPurchaseOrder(supplierId, [{ product: other, quantity: 30 }]);

    const trace = world.newTraceNo();
    const result = await scan(trace, 8, { supplierId });

    expect(result.status).toBe("PENDING_MAPPING");
    expect(result.productId).toBeNull();
    expect((await scanRow(trace)).status).toBe("PENDING_MAPPING");
  });

  it("상품을 사람이 나중에 지정하는 순간 판정된다 — 붙으면 남은 양, 넘치면 받지 않고 재고에 안 넣는다", async () => {
    const supplierId = await newSupplier("다");
    const product = await world.createProduct({ stock_quantity: 0 });

    await newPurchaseOrder(supplierId, [{ product, quantity: 10 }]);

    // 축종을 모르는 이력이라 자동 생성이 못 하고 상품 확인 필요로 남는다.
    const firstTrace = world.newTraceNo();

    await world.seedTrace(firstTrace, { speciesGroup: null, part: null, grade: null });

    const pending = await recordScanAction({ traceNo: firstTrace, weight: 8, scanType: "MANUAL", supplierId });

    expect(pending.data).toMatchObject({ status: "PENDING_MAPPING", po: null });

    const resolved = await resolveMappingAction((pending.data as ScanResult).scanId, product.id, false);

    expect(resolved.success).toBe(true);
    expect(resolved.data?.po).toMatchObject({ result: "ASSIGNED", remaining: 2 });
    expect(await stockOf(product.id)).toBe(8);

    const secondTrace = world.newTraceNo();

    await world.seedTrace(secondTrace, { speciesGroup: null, part: null, grade: null });

    const pendingOver = await recordScanAction({ traceNo: secondTrace, weight: 5, scanType: "MANUAL", supplierId });
    const rejected = await resolveMappingAction((pendingOver.data as ScanResult).scanId, product.id, false);

    expect(rejected.success).toBe(true);
    expect(rejected.data?.po).toMatchObject({ result: "REJECTED", reason: "OVER" });
    expect(await stockOf(product.id)).toBe(8);
    expect((await scanRow(secondTrace)).status).toBe("VOIDED");
  });

  it("이력번호를 바로잡아 새 박스가 만들어져도 거래처가 따라간다(발주서에 맞는 상품이 없으면 그 자리에서 보관)", async () => {
    const supplierId = await newSupplier("라");
    const other = await world.createProduct({ stock_quantity: 0 });

    await newPurchaseOrder(supplierId, [{ product: other, quantity: 30 }]);

    // 조회가 안 된 박스(이력 미확인) — 아직 판정할 상품이 없다.
    const wrongTrace = world.newTraceNo();
    const pending = await recordScanAction({ traceNo: wrongTrace, weight: 6, scanType: "MANUAL", supplierId });

    expect(pending.success).toBe(true);
    expect((pending.data as ScanResult).status).toBe("EXCEPTION");

    const rightTrace = world.newTraceNo();

    await world.seedTrace(rightTrace, { part: "등심" });

    const replaced = await replaceScanTraceNoAction((pending.data as ScanResult).scanId, rightTrace);
    const data = replaced.data as ReplaceTraceResult;

    expect(replaced.success, replaced.error).toBe(true);
    expect(data.status).toBe("PENDING_MAPPING");
    expect((await scanRow(rightTrace)).supplier_id).toBe(supplierId);
  });

  it("박스 분류입고 — 한 줄이라도 거절되면 앞서 넣은 줄까지 전부 취소한다", async () => {
    const supplierId = await newSupplier("마");
    const p1 = await world.createProduct({ stock_quantity: 0 });
    const p2 = await world.createProduct({ stock_quantity: 0 });

    await newPurchaseOrder(supplierId, [
      { product: p1, quantity: 10 },
      { product: p2, quantity: 10 },
    ]);

    const box = world.newTraceNo();

    await world.seedTrace(box, { part: "등심" });

    const result = await recordSplitScansAction({
      boxCode: box,
      supplierId,
      rows: [
        { productId: p1.id, weight: 8 },
        { productId: p2.id, weight: 12 },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("2번째 줄");
    expect(result.error).toContain("발주 수량을 넘어");
    expect(await stockOf(p1.id)).toBe(0);
    expect(await stockOf(p2.id)).toBe(0);
  });
});
