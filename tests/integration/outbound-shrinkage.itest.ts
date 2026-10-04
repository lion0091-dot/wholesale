/**
 * 출고 중 박스 소진 → 감량(마이그레이션 229). 실중량 출고 + "박스 다 썼음"이 남은 장부 중량을 LOSS로 기록하고 박스를 비우는지,
 * 이 주문에 배정되지 않은 박스·남의 공급사·고객 계정은 못 건드리는지 확인한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";
import { recordScanAction } from "@/app/dashboard/inbound/actions";
import { updateOrderStatusAction } from "@/app/dashboard/orders/actions";
import { getBoxLeftoverAction, recordOutboundScanAction } from "@/app/dashboard/outbound/actions";

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

function newProduct(): Promise<WorldProduct> {
  return world.createProduct({ stock_quantity: 0, category: "소", subcategory: "등심" });
}

async function intake(product: WorldProduct, weight: number): Promise<string> {
  const traceNo = world.newTraceNo();

  await world.seedTrace(traceNo, { part: "등심" });

  const result = await recordScanAction({ traceNo, weight, scanType: "BARCODE_SCAN", productId: product.id });

  expect(result.success).toBe(true);

  return traceNo;
}

async function confirmedOrder(product: WorldProduct, quantity: number): Promise<string> {
  const orderId = await world.createOrder({ product, quantity, unitPrice: 15000 });

  expect((await updateOrderStatusAction(orderId, "confirmed")).success).toBe(true);

  return orderId;
}

async function box(traceNo: string) {
  const { data } = await adminClient()
    .from("inbound_scans")
    .select("id, remaining_weight")
    .eq("trace_no", traceNo)
    .single();

  return { id: String(data?.id), remaining: Number(data?.remaining_weight) };
}

describe("출고 감량 처리", () => {
  it("박스 다 썼음: 남은 장부 중량이 LOSS로 기록되고 박스가 비며 폐기 이력이 남는다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 10);
    const orderId = await confirmedOrder(product, 9.5);

    // 장부는 10kg인데 실중량 9.5kg을 달아 내보내고 박스를 다 썼다고 표시
    const result = await recordOutboundScanAction(orderId, traceNo, 9.5, true);

    expect(result.success).toBe(true);
    expect(result.data?.shrinkageError).toBeNull();
    expect(result.data?.shrinkage).toBeCloseTo(0.5, 3);

    const after = await box(traceNo);

    expect(after.remaining).toBe(0);

    const { data: loss } = await adminClient()
      .from("stock_ledger")
      .select("qty_delta, event_type")
      .eq("inbound_scan_id", after.id)
      .eq("event_type", "LOSS");

    expect(loss).toHaveLength(1);
    expect(Number(loss?.[0].qty_delta)).toBeCloseTo(-0.5, 3);

    const { data: disposal } = await adminClient()
      .from("box_disposals")
      .select("reason_code, weight, after_remaining")
      .eq("inbound_scan_id", after.id);

    expect(disposal).toHaveLength(1);
    expect(disposal?.[0].reason_code).toBe("SHRINKAGE");
    expect(Number(disposal?.[0].weight)).toBeCloseTo(0.5, 3);
  });

  it("체크하지 않으면 감량은 생기지 않는다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 10);
    const orderId = await confirmedOrder(product, 9.5);

    const result = await recordOutboundScanAction(orderId, traceNo, 9.5);

    expect(result.success).toBe(true);
    expect(result.data?.shrinkage).toBe(0);

    const { count } = await adminClient()
      .from("box_disposals")
      .select("id", { count: "exact", head: true })
      .eq("trace_no", traceNo);

    expect(count).toBe(0);
  });

  it("고객 계정은 감량 RPC를 직접 불러도 거부된다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 10);
    const orderId = await confirmedOrder(product, 5);

    await recordOutboundScanAction(orderId, traceNo, 5);
    await actAs(world.users.retailerR);

    const { getActorClient } = await import("./harness");
    const { error } = await getActorClient().rpc("exhaust_box_after_outbound", { p_order_id: orderId, p_trace_no: traceNo });

    expect(error).not.toBeNull();
    expect((await box(traceNo)).remaining).toBe(5);
  });

  it("다른 공급사 사장은 남의 주문의 박스를 비울 수 없다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 10);
    const orderId = await confirmedOrder(product, 5);

    await recordOutboundScanAction(orderId, traceNo, 5);
    await actAs(world.users.ownerB);

    const { getActorClient } = await import("./harness");
    const { error } = await getActorClient().rpc("exhaust_box_after_outbound", { p_order_id: orderId, p_trace_no: traceNo });

    expect(error).not.toBeNull();
    expect((await box(traceNo)).remaining).toBe(5);
  });

  it("이 주문에 배정되지 않은 박스는 비울 수 없다", async () => {
    const product = await newProduct();
    const assigned = await intake(product, 10);
    const other = await intake(product, 10);
    const orderId = await confirmedOrder(product, 5);

    await recordOutboundScanAction(orderId, assigned, 5);

    const { getActorClient } = await import("./harness");
    const { error } = await getActorClient().rpc("exhaust_box_after_outbound", { p_order_id: orderId, p_trace_no: other });

    expect(error?.message).toContain("BOX_NOT_ASSIGNED_TO_ORDER");
    expect((await box(other)).remaining).toBe(10);
  });

  it("두 번 불러도 감량이 중복 기록되지 않는다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 10);
    const orderId = await confirmedOrder(product, 9);

    await recordOutboundScanAction(orderId, traceNo, 9, true);

    const { getActorClient } = await import("./harness");
    const { data } = await getActorClient().rpc("exhaust_box_after_outbound", { p_order_id: orderId, p_trace_no: traceNo });

    expect(Number((data as { weight: number }).weight)).toBe(0);

    const { count } = await adminClient()
      .from("box_disposals")
      .select("id", { count: "exact", head: true })
      .eq("trace_no", traceNo);

    expect(count).toBe(1);
  });

  it("실중량이 장부 잔량보다 적으면 남은 잔량을 돌려주고, 같거나 크면 묻지 않는다 — 확정으로 자동 배정된 박스도 배정 전 잔량으로 본다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 10);
    const orderId = await confirmedOrder(product, 10);

    // 확정 때 박스가 자동 배정돼 장부 잔량은 0이다 — 그래도 첫 스캔 때 풀리므로 10kg으로 판단해야 한다.
    expect((await box(traceNo)).remaining).toBe(0);
    expect((await getBoxLeftoverAction(orderId, traceNo, 9.5)).data).toBe(10);
    expect((await getBoxLeftoverAction(orderId, traceNo, 10)).data).toBeNull();
    expect((await getBoxLeftoverAction(orderId, traceNo, 12)).data).toBeNull();
    expect((await getBoxLeftoverAction(orderId, traceNo.toLowerCase(), 5)).data).toBe(10);
    expect((await getBoxLeftoverAction(orderId, "999999999999", 5)).data).toBeNull();
  });

  it("첫 스캔 뒤에는 배정이 풀렸으므로 장부 잔량 그대로 판단한다", async () => {
    const product = await newProduct();
    const first = await intake(product, 10);
    const second = await intake(product, 10);
    const orderId = await confirmedOrder(product, 12);

    await recordOutboundScanAction(orderId, first, 10);

    // 두 번째 박스는 아직 아무 배정도 없고 잔량은 10 — 이미 배정이 풀린 뒤라 더해지는 값이 없어야 한다.
    expect((await getBoxLeftoverAction(orderId, second, 2)).data).toBe(10);
    expect((await box(second)).remaining).toBe(10);
  });

  it("다른 공급사 사장·고객에게는 남의 박스 잔량이 보이지 않는다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 10);
    const orderId = await confirmedOrder(product, 5);

    await actAs(world.users.ownerB);
    expect((await getBoxLeftoverAction(orderId, traceNo, 3)).data ?? null).toBeNull();

    await actAs(world.users.retailerR);
    expect((await getBoxLeftoverAction(orderId, traceNo, 3)).success).toBe(false);
  });
});
