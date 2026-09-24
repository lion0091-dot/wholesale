/**
 * 4. 출고 — 서버 액션 한 겹(권한·DB 오류 코드의 현장 문구 번역·응답 변환) + 실제 DB.
 * 입고(recordScanAction)로 박스를 만들고 주문 확정(updateOrderStatusAction)으로 자동 배정을 태운 뒤 출고한다.
 * DB 함수 레벨은 scripts/db-test-orders-outbound.sql 이 이미 한다. 외부 API 없음.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";
import { recordScanAction } from "@/app/dashboard/inbound/actions";
import { updateOrderStatusAction } from "@/app/dashboard/orders/actions";
import {
  finalizeShipmentAction,
  getOutboundProgressAction,
  getPickingListAction,
  previewShipmentAction,
  recordOutboundScanAction,
} from "@/app/dashboard/outbound/actions";

let world: World;

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** 상품 — 재고 0에서 시작해(원장 편입 시 수동 재고 이관을 피함) 박스 입고만으로 재고를 만든다. */
function newProduct(overrides: Record<string, unknown> = {}): Promise<WorldProduct> {
  return world.createProduct({ stock_quantity: 0, category: "소", subcategory: "등심", ...overrides });
}

/** 박스 1개 입고 — 이력 캐시를 시드하고 실제 입고 액션을 태운다. */
async function intake(
  product: WorldProduct,
  weight: number,
  options: { part?: string | null; bestBefore?: string } = {}
): Promise<string> {
  const traceNo = world.newTraceNo();

  await world.seedTrace(traceNo, { part: options.part === undefined ? "등심" : options.part });

  const result = await recordScanAction({
    traceNo,
    weight,
    scanType: "BARCODE_SCAN",
    productId: product.id,
    bestBefore: options.bestBefore ?? null,
  });

  expect(result.success).toBe(true);

  return traceNo;
}

/** 접수대기 주문을 만들고 확정까지 — 확정 때 선입선출로 박스가 자동 배정된다. */
async function confirmedOrder(product: WorldProduct, quantity: number, unitPrice = 15000): Promise<string> {
  const orderId = await world.createOrder({ product, quantity, unitPrice });
  const result = await updateOrderStatusAction(orderId, "confirmed");

  expect(result.success).toBe(true);

  return orderId;
}

async function orderRow(orderId: string) {
  const { data } = await adminClient().from("orders").select("status, total_amount").eq("id", orderId).single();

  return { status: String(data?.status), totalAmount: Number(data?.total_amount) };
}

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

beforeEach(async () => {
  await actAs(world.users.ownerA);
});

describe("출고 — 권한·격리", () => {
  it("비로그인은 모든 출고 액션이 거부된다", async () => {
    const product = await newProduct();

    await intake(product, 5);
    const orderId = await confirmedOrder(product, 2);

    await actAs(null);

    for (const result of [
      await recordOutboundScanAction(orderId, "999999999999"),
      await getOutboundProgressAction(orderId),
      await getPickingListAction(orderId),
      await previewShipmentAction(orderId),
      await finalizeShipmentAction(orderId),
    ]) {
      expect(result.success).toBe(false);
      expect(result.error).toContain("로그인");
    }
  });

  it("고객(소매) 계정은 출고를 처리할 수 없다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 5);
    const orderId = await confirmedOrder(product, 2);

    await actAs(world.users.retailerR);

    expect((await recordOutboundScanAction(orderId, traceNo)).success).toBe(false);
    expect((await finalizeShipmentAction(orderId)).success).toBe(false);
    expect((await getPickingListAction(orderId)).success).toBe(false);
    expect((await orderRow(orderId)).status).toBe("confirmed");
  });

  it("다른 공급사 사장은 남의 주문을 스캔·마감할 수 없고 피킹·미리보기도 0건이다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 5);
    const orderId = await confirmedOrder(product, 2);

    await actAs(world.users.ownerB);

    expect(await recordOutboundScanAction(orderId, traceNo)).toEqual({ success: false, error: "발주서를 찾을 수 없습니다." });
    expect(await finalizeShipmentAction(orderId)).toEqual({ success: false, error: "발주서를 찾을 수 없습니다." });
    expect((await getPickingListAction(orderId)).data).toEqual([]);
    expect((await previewShipmentAction(orderId)).data).toEqual([]);
    expect((await orderRow(orderId)).status).toBe("confirmed");
  });

  it("직원(staff)은 스캔과 마감을 할 수 있다(현장 작업)", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 5);
    const orderId = await confirmedOrder(product, 2);

    await actAs(world.users.staffA);
    const scan = await recordOutboundScanAction(orderId, traceNo);
    const finalized = await finalizeShipmentAction(orderId);

    expect(scan.success).toBe(true);
    expect(finalized.success).toBe(true);
    expect((await orderRow(orderId)).status).toBe("shipping");
  });
});

describe("출고 — 정상 흐름(피킹 → 정정 스캔 → 진행률 → 미리보기 → 마감)", () => {
  it("확정 때 자동 배정된 박스를 작업자가 실제 집은 다른 박스로 정정하고 마감하면 금액이 확정된다", async () => {
    const product = await newProduct();
    const first = await intake(product, 5);
    const second = await intake(product, 5);
    const orderId = await confirmedOrder(product, 4, 15000);

    // 선입선출 자동 배정 = 먼저 들어온 박스
    const picking = await getPickingListAction(orderId);

    expect(picking.success).toBe(true);
    expect(picking.data).toHaveLength(1);
    expect(picking.data![0]).toMatchObject({ traceNo: first, suggestedQty: 4, alreadyPicked: false, productName: product.name });

    // 작업자는 실제로 second 를 집었다
    const scan = await recordOutboundScanAction(orderId, second);

    expect(scan.success).toBe(true);
    expect(scan.data).toMatchObject({ traceNo: second, taken: 4, ordered: 4, remainingNeeded: 0, productName: product.name });

    const progress = await getOutboundProgressAction(orderId);

    expect(progress.data).toHaveLength(1);
    expect(progress.data![0]).toMatchObject({ productId: product.id, unit: "kg", orderedQty: 4, scannedQty: 4 });
    expect(progress.data![0].traceNos).toContain(second);

    const after = await getPickingListAction(orderId);

    expect(after.data!.filter((row) => row.alreadyPicked).map((row) => row.traceNo)).toEqual([second]);

    const preview = await previewShipmentAction(orderId);

    expect(preview.data).toHaveLength(1);
    expect(preview.data![0]).toMatchObject({ unitPrice: 15000, orderedQty: 4, shippedQty: 4, diffQty: 0, orderedAmount: 60000, shippedAmount: 60000 });

    const finalized = await finalizeShipmentAction(orderId);

    expect(finalized).toEqual({ success: true, data: { wasShort: false, prevAmount: 60000, totalAmount: 60000 } });
    expect(await orderRow(orderId)).toEqual({ status: "shipping", totalAmount: 60000 });
  });

  it("실중량을 지정해 덜 찍으면 부족 마감은 확인 없이는 막히고, 확인하면 실출고량 기준으로 금액이 줄어든다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 5);
    const orderId = await confirmedOrder(product, 4, 15000);

    const scan = await recordOutboundScanAction(orderId, traceNo, 1.5);

    expect(scan.data).toMatchObject({ taken: 1.5, ordered: 4, remainingNeeded: 2.5 });

    const preview = await previewShipmentAction(orderId);

    expect(preview.data![0]).toMatchObject({ shippedQty: 1.5, diffQty: -2.5, orderedAmount: 60000, shippedAmount: 22500 });

    const blocked = await finalizeShipmentAction(orderId);

    expect(blocked).toEqual({ success: false, error: "SHIPMENT_SHORT" });
    expect((await orderRow(orderId)).status).toBe("confirmed");

    const confirmed = await finalizeShipmentAction(orderId, true);

    expect(confirmed).toEqual({ success: true, data: { wasShort: true, prevAmount: 60000, totalAmount: 22500 } });
    expect(await orderRow(orderId)).toEqual({ status: "shipping", totalAmount: 22500 });
  });

  it("이미 마감한 주문을 다시 마감하거나 추가로 스캔하면 안내 문구로 거부된다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 5);
    const orderId = await confirmedOrder(product, 2);

    expect((await recordOutboundScanAction(orderId, traceNo)).success).toBe(true);
    expect((await finalizeShipmentAction(orderId)).success).toBe(true);

    expect(await finalizeShipmentAction(orderId)).toEqual({ success: false, error: "이미 마감된 발주서입니다." });

    const scan = await recordOutboundScanAction(orderId, traceNo);

    expect(scan.success).toBe(false);
    expect(scan.error).toContain("이미 마감(금액 확정)된 발주서");
  });
});

describe("출고 스캔 — DB 오류 코드가 현장 문구로 번역된다", () => {
  it("재고에 없는 이력번호", async () => {
    const product = await newProduct();

    await intake(product, 5);
    const orderId = await confirmedOrder(product, 2);
    const result = await recordOutboundScanAction(orderId, "999999999999");

    expect(result.success).toBe(false);
    expect(result.error).toContain("재고에 없는 이력번호입니다");
    expect(result.error).not.toContain("BOX_NOT_AVAILABLE");
  });

  it("주문에 없는 상품의 박스", async () => {
    const product = await newProduct();
    const other = await newProduct({ subcategory: "안심" });

    await intake(product, 5);
    const otherBox = await intake(other, 5);
    const orderId = await confirmedOrder(product, 2);
    const result = await recordOutboundScanAction(orderId, otherBox);

    expect(result.success).toBe(false);
    expect(result.error).toContain("이 주문에 없는 상품입니다");
  });

  it("주문 수량을 이미 다 채운 상품의 박스를 또 찍으면 거부된다", async () => {
    const product = await newProduct();
    const first = await intake(product, 5);
    const second = await intake(product, 5);
    const orderId = await confirmedOrder(product, 4);

    expect((await recordOutboundScanAction(orderId, first)).data).toMatchObject({ remainingNeeded: 0 });

    const result = await recordOutboundScanAction(orderId, second);

    expect(result.success).toBe(false);
    expect(result.error).toContain("주문 수량을 이미 다 채웠습니다");
  });

  it("유통기한이 지난 박스는 날짜를 짚어 거부하고 날것의 코드를 노출하지 않는다", async () => {
    const product = await newProduct();
    const yesterday = isoDay(-1);

    await intake(product, 5);
    const expired = await intake(product, 3, { bestBefore: yesterday });
    const orderId = await confirmedOrder(product, 2);
    const result = await recordOutboundScanAction(orderId, expired);

    expect(result.success).toBe(false);
    expect(result.error).toContain(`유통기한이 지난 박스입니다 (${yesterday})`);
    expect(result.error).not.toContain("BOX_EXPIRED");
  });

  it("접수대기 주문은 스캔·마감할 수 없다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 5);
    const orderId = await world.createOrder({ product, quantity: 2 });

    const scan = await recordOutboundScanAction(orderId, traceNo);
    const finalized = await finalizeShipmentAction(orderId);

    expect(scan).toEqual({ success: false, error: "확정 또는 배송중 상태의 발주서만 출고할 수 있습니다." });
    expect(finalized).toEqual({ success: false, error: "확정 상태의 발주서만 마감할 수 있습니다." });
  });

  it("존재하지 않는 주문 ID는 '발주서를 찾을 수 없습니다'", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";

    expect(await recordOutboundScanAction(missing, "999999999999")).toEqual({ success: false, error: "발주서를 찾을 수 없습니다." });
    expect(await finalizeShipmentAction(missing)).toEqual({ success: false, error: "발주서를 찾을 수 없습니다." });
  });
});

describe("출고 스캔 — 응답 변환", () => {
  it("박스 이력 부위와 상품 부위가 다르면 막지 않고 partMismatch 로 알린다", async () => {
    const product = await newProduct({ category: "돼지", subcategory: "목살" });
    const traceNo = await intake(product, 5, { part: "등심" });
    const orderId = await confirmedOrder(product, 2);
    const result = await recordOutboundScanAction(orderId, traceNo);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ partMismatch: true, tracePart: "등심", productPart: "목살" });
  });

  it("부위가 같으면 partMismatch 가 꺼져 있다", async () => {
    const product = await newProduct();
    const traceNo = await intake(product, 5, { part: "등심" });
    const orderId = await confirmedOrder(product, 2);
    const result = await recordOutboundScanAction(orderId, traceNo);

    expect(result.data).toMatchObject({ partMismatch: false });
  });

  it("유통기한 임박 박스는 남은 일수와 기한이 함께 돌아온다(막지 않음)", async () => {
    const product = await newProduct();
    const soon = isoDay(2);
    const traceNo = await intake(product, 5, { bestBefore: soon });
    const orderId = await confirmedOrder(product, 2);
    const result = await recordOutboundScanAction(orderId, traceNo);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ bestBefore: soon, daysLeft: 2 });
  });
});
