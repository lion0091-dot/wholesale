/**
 * 출고 따라가기·분기 테스트 — 출고 스캔 화면이 실제로 쓰는 조회(loadOutboundOrders)와 액션으로 하루를 끝까지 걸으며,
 * 단계마다 안내가 다음 할 일을 말하는지, 막혔을 때 오류 문구가 다음에 무엇을 할지 알려 주는지 본다.
 * 세부 권한·DB 오류 번역은 outbound.itest.ts가 이미 한다. 기준은 입고와 같다: 업무를 몰라도 안내만 따라가면 끝까지 간다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";
import { recordScanAction, voidScanAction } from "@/app/dashboard/inbound/actions";
import {
  finalizeShipmentAction,
  getOutboundProgressAction,
  previewShipmentAction,
  recordOutboundScanAction,
} from "@/app/dashboard/outbound/actions";
import { loadOutboundOrders } from "@/app/dashboard/outbound/outbound-data";
import { updateOrderStatusAction } from "@/app/dashboard/orders/actions";
import { pickOutboundGuide } from "@/lib/livestock/outbound-next-step";
import type { SupplierScope } from "@/lib/supplier/scope";

let world: World;
let scope: SupplierScope;

beforeAll(async () => {
  world = await seedWorld();
  scope = {
    userId: world.users.ownerA.id,
    organizationId: null,
    orgRole: "owner",
    platformRole: null,
    isSuperAdmin: false,
    wholesalerId: world.wholesalerA,
    businessName: "테스트",
    shopToken: null,
  };
});

afterAll(async () => {
  await world?.cleanup();
});

beforeEach(async () => {
  await actAs(world.users.ownerA);
});

let productSeq = 0;

/** 소 상품은 부위·등급·원산지가 겹치면 만들 수 없어(중복 제어) 상품마다 부위 이름을 다르게 준다. */
function newProduct(overrides: Record<string, unknown> = {}): Promise<WorldProduct> {
  productSeq += 1;

  return world.createProduct({ stock_quantity: 0, category: "소", subcategory: `부위${productSeq}`, ...overrides });
}

async function intake(product: WorldProduct, weight: number): Promise<string> {
  const traceNo = world.newTraceNo();

  await world.seedTrace(traceNo, { part: "등심" });

  const result = await recordScanAction({ traceNo, weight, scanType: "BARCODE_SCAN", productId: product.id });

  expect(result.success, result.error).toBe(true);

  return traceNo;
}

async function confirmedOrder(product: WorldProduct, quantity: number, unitPrice = 15000): Promise<string> {
  const orderId = await world.createOrder({ product, quantity, unitPrice });

  expect((await updateOrderStatusAction(orderId, "confirmed")).success).toBe(true);

  return orderId;
}

/** 확정 상태 주문을 직접 만든다 — 확정 때 자동 배정·재고 부족 검사를 거치지 않는다(박스 못 찾음·동시 스캔 케이스용). */
function openOrder(product: WorldProduct, quantity: number): Promise<string> {
  return world.createOrder({ product, quantity, unitPrice: 15000, status: "confirmed" });
}

async function orders() {
  await actAs(world.users.ownerA);

  return loadOutboundOrders(scope);
}

/** 화면이 그리는 안내 — 목록에서 고른 발주서와 진행표를 그대로 넘긴다. */
async function guideFor(orderId: string) {
  const list = await orders();
  const selected = list.find((order) => order.id === orderId) ?? null;
  const progress = (await getOutboundProgressAction(orderId)).data ?? [];

  return pickOutboundGuide({
    orderCount: list.length,
    openOrderCount: list.filter((order) => !order.finalized).length,
    selected: selected ? { status: selected.status, finalized: selected.finalized } : null,
    progress: progress.map((row) => ({ orderedQty: row.orderedQty, scannedQty: row.scannedQty })),
  });
}

async function assignedSum(orderId: string): Promise<number> {
  const { data } = await adminClient()
    .from("stock_ledger")
    .select("qty_delta")
    .eq("source_type", "order")
    .eq("source_id", orderId)
    .eq("event_type", "OUTBOUND_ASSIGN");

  return ((data ?? []) as Array<{ qty_delta: number }>).reduce((sum, row) => sum - Number(row.qty_delta), 0);
}

describe("따라가기 1 — 발주서 두 건, 찍고 마감하고 다음 발주서로 넘어가는 하루", () => {
  it("단계마다 안내가 다음 할 일을 말하고, 마감된 발주서는 목록 뒤로 가며 더 못 찍는다는 안내가 나온다", async () => {
    const [p1, p2] = [await newProduct(), await newProduct()];
    const [b1, b2] = [await intake(p1, 5), await intake(p1, 5)];
    const b3 = await intake(p2, 6);
    const first = await confirmedOrder(p1, 8);
    const second = await confirmedOrder(p2, 3);

    // 1. 발주서가 목록에 있고, 아직 아무것도 안 찍었으면 "가져올 박스를 찍으세요"
    let list = await orders();

    expect(list.map((order) => order.id)).toEqual(expect.arrayContaining([first, second]));
    expect((await guideFor(first)).key).toBe("scan-first");

    // 2. 한 박스 — 남은 상품을 더 찍으라고
    expect((await recordOutboundScanAction(first, b1)).success).toBe(true);
    expect((await guideFor(first)).key).toBe("scan-more");

    // 3. 나머지까지 채우면 "이제 출고 마감을 누르세요"(큰 버튼)
    const done = await recordOutboundScanAction(first, b2);

    expect(done.success).toBe(true);

    const finalizeGuide = await guideFor(first);

    expect(finalizeGuide.key).toBe("finalize");
    expect(finalizeGuide.action).toMatchObject({ kind: "finalize" });

    // 4. 마감 — 금액이 확정되고, 그 발주서는 목록 뒤로 가서 "마감됨"이 된다
    expect(await finalizeShipmentAction(first)).toEqual({ success: true, data: { wasShort: false, prevAmount: 120000, totalAmount: 120000 } });
    list = await orders();

    const firstRow = list.find((order) => order.id === first)!;

    expect(firstRow.finalized).toBe(true);
    expect(list.findIndex((order) => order.finalized)).toBeGreaterThanOrEqual(0);
    expect(list.slice(list.findIndex((order) => order.finalized)).every((order) => order.finalized)).toBe(true);
    expect((await guideFor(first)).key).toBe("finalized");

    // 5. 마감된 발주서에 또 찍으면 사유를 알려 주고, 다음 발주서(아직 안 마감)는 그대로 찍힌다
    const again = await recordOutboundScanAction(first, b1);

    expect(again.success).toBe(false);
    expect(again.error).toContain("이미 마감");
    expect(list.find((order) => order.id === second)!.finalized).toBe(false);
    expect((await recordOutboundScanAction(second, b3)).success).toBe(true);
  });
});

describe("따라가기 2 — 발주서가 많아도, 마감된 발주서가 쌓여도 새 발주서가 목록에서 사라지지 않는다", () => {
  it("마감된 발주서는 뒤로 가고 아직 마감 안 된 발주서가 앞에 있으며, 50건이 넘어도 가장 최근 발주서가 보인다", async () => {
    const product = await newProduct();

    // 오래전에 마감돼 배송 대기 중인 발주서 5건 — 예전 목록에서는 이것들이 맨 앞을 차지했다.
    const finalizedIds: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      finalizedIds.push(
        await world.createOrder({
          product,
          status: "shipping",
          orderFields: { ordered_at: new Date(Date.now() - (30 - i) * 86_400_000).toISOString(), shipment_finalized_at: new Date(Date.now() - 86_400_000).toISOString() },
        })
      );
    }

    const openIds: string[] = [];

    for (let i = 0; i < 52; i += 1) {
      openIds.push(await world.createOrder({ product, status: "confirmed", orderFields: { ordered_at: new Date(Date.now() - (20 - i * 0.3) * 3_600_000).toISOString() } }));
    }

    const list = await orders();
    const ids = list.map((order) => order.id);

    expect(list[0].finalized).toBe(false);
    expect(ids).toContain(openIds[openIds.length - 1]);
    expect(list.filter((order) => order.finalized).map((order) => order.id)).toEqual(expect.arrayContaining(finalizedIds));

    const firstFinalized = list.findIndex((order) => order.finalized);

    expect(list.slice(firstFinalized).every((order) => order.finalized)).toBe(true);
  });
});

describe("따라가기 3 — 박스를 못 찾았을 때 이유별로 다음 할 일을 알려 준다", () => {
  it("이미 이 주문에 찍은 박스를 또 찍으면 '이미 이 주문에 찍었습니다'(같은 박스 이중 스캔)", async () => {
    const product = await newProduct();
    const box = await intake(product, 5);
    const orderId = await openOrder(product, 8);

    expect((await recordOutboundScanAction(orderId, box)).success).toBe(true);

    const twice = await recordOutboundScanAction(orderId, box);

    expect(twice.success).toBe(false);
    expect(twice.error).toContain("이미 이 주문에 찍었습니다");
    expect(await assignedSum(orderId)).toBeCloseTo(5);
  });

  it("입고는 됐지만 상품이 안 정해진 박스는 '입고 스캔에서 상품을 지정하라'고 알려 준다", async () => {
    const product = await newProduct();
    const orderId = await openOrder(product, 4);
    const trace = world.newTraceNo();

    await adminClient()
      .from("inbound_scans")
      .insert({ wholesaler_id: world.wholesalerA, trace_no: trace, weight: 5, unit: "kg", scan_type: "BARCODE_SCAN", status: "PENDING_MAPPING", remaining_weight: 0 });

    const result = await recordOutboundScanAction(orderId, trace);

    expect(result.success).toBe(false);
    expect(result.error).toContain("입고 스캔");
    expect(result.error).toContain("상품");
  });

  it("다른 주문으로 이미 다 나간 박스는 그렇다고 알려 준다", async () => {
    const product = await newProduct();
    const box = await intake(product, 5);
    const other = await confirmedOrder(product, 5);
    const mine = await openOrder(product, 3);

    expect((await recordOutboundScanAction(other, box)).success).toBe(true);

    const result = await recordOutboundScanAction(mine, box);

    expect(result.success).toBe(false);
    expect(result.error).toContain("이미 다 나갔습니다");
  });

  it("입고를 취소한 박스는 취소됐다고 알려 준다", async () => {
    const product = await newProduct();
    const orderId = await openOrder(product, 3);
    const box = await intake(product, 5);
    const { data } = await adminClient().from("inbound_scans").select("id").eq("wholesaler_id", world.wholesalerA).eq("trace_no", box).single();

    expect((await voidScanAction(String(data?.id))).success).toBe(true);

    const result = await recordOutboundScanAction(orderId, box);

    expect(result.success).toBe(false);
    expect(result.error).toContain("취소된 입고 박스");
  });

  it("입고된 적이 없는 번호는 기존 안내(재고에 없는 이력번호)를 그대로 준다", async () => {
    const product = await newProduct();
    const orderId = await openOrder(product, 3);
    const result = await recordOutboundScanAction(orderId, world.newTraceNo());

    expect(result.success).toBe(false);
    expect(result.error).toContain("재고에 없는 이력번호입니다");
  });
});

describe("따라가기 4 — 재고 확보 대기 발주서는 마감이 막힌 이유와 다음 할 일을 알려 준다", () => {
  it("목록에 나오고 안내가 '확정 뒤에 마감'이라고 하며, 마감하려 하면 같은 안내 문구로 거부된다", async () => {
    const product = await newProduct();
    const orderId = await world.createOrder({ product, status: "awaiting_stock", quantity: 3 });

    expect((await orders()).find((order) => order.id === orderId)?.status).toBe("awaiting_stock");
    expect((await guideFor(orderId)).key).toBe("awaiting-stock");

    const result = await finalizeShipmentAction(orderId);

    expect(result.success).toBe(false);
    expect(result.error).toContain("재고 확보 대기");
    expect(result.error).toContain("확정");
  });
});

describe("따라가기 5 — 동시에 같은 박스를 두 번 찍어도 나간 양이 어긋나지 않는다", () => {
  it("박스(5)가 주문(8)보다 작을 때: 하나만 성공하고 나머지는 '이미 찍었습니다', 나간 양은 정확히 5", async () => {
    const product = await newProduct();
    const box = await intake(product, 5);
    const orderId = await openOrder(product, 8);
    const results = await Promise.all(Array.from({ length: 4 }, () => recordOutboundScanAction(orderId, box)));

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success).every((result) => /이미 이 주문에 찍었습니다/.test(result.error ?? ""))).toBe(true);
    expect(await assignedSum(orderId)).toBeCloseTo(5);
  });

  it("박스(10)가 주문(4)보다 클 때: 하나만 4를 가져가고 나머지는 '주문 수량을 이미 다 채웠습니다', 박스에는 6이 남는다", async () => {
    const product = await newProduct();
    const box = await intake(product, 10);
    const orderId = await confirmedOrder(product, 4);
    const results = await Promise.all(Array.from({ length: 4 }, () => recordOutboundScanAction(orderId, box)));

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success).every((result) => /이미 다 채웠습니다/.test(result.error ?? ""))).toBe(true);
    expect(await assignedSum(orderId)).toBeCloseTo(4);

    const { data } = await adminClient().from("inbound_scans").select("remaining_weight").eq("wholesaler_id", world.wholesalerA).eq("trace_no", box).single();

    expect(Number(data?.remaining_weight)).toBeCloseTo(6);
  });
});

describe("따라가기 6 — 찍지 않고 마감하는 길", () => {
  it("확정 때 자동 배정된 박스가 있으면 찍지 않고 마감해도 추천 박스가 나간 것으로 처리되어 확인 창 없이 끝난다", async () => {
    const product = await newProduct();

    await intake(product, 5);

    const orderId = await confirmedOrder(product, 4);
    const preview = await previewShipmentAction(orderId);

    expect(preview.data![0]).toMatchObject({ shippedQty: 4, diffQty: 0 });
    expect(await finalizeShipmentAction(orderId)).toEqual({ success: true, data: { wasShort: false, prevAmount: 60000, totalAmount: 60000 } });
  });

  it("나갈 박스가 하나도 없으면(찍은 것도 자동 배정도 없음) 미리보기가 전부 0이고, 확인해야만 0원으로 마감된다", async () => {
    const product = await newProduct();
    const orderId = await world.createOrder({ product, status: "confirmed", quantity: 3 });
    const preview = await previewShipmentAction(orderId);

    expect(preview.data!.every((row) => row.shippedQty === 0)).toBe(true);
    expect(await finalizeShipmentAction(orderId)).toEqual({ success: false, error: "SHIPMENT_SHORT" });
    expect(await finalizeShipmentAction(orderId, true)).toMatchObject({ success: true, data: { totalAmount: 0 } });
  });
});

describe("규모 — 박스가 수천 개 쌓여도 출고 화면이 매 스캔마다 부르는 함수들이 빠르다(성능 가드)", () => {
  const BOXES = 2500;
  const LIMIT_MS = 1500;

  it(`박스 ${BOXES}개에서 확정(선입선출 배정)·피킹 목록·진행표·스캔이 각각 ${LIMIT_MS}ms 안이고, 20명이 동시에 피킹 목록을 열어도 상한 안이다`, async () => {
    const product = await newProduct();
    const now = Date.now();
    const scans = Array.from({ length: BOXES }, (_, index) => ({
      id: crypto.randomUUID(),
      wholesaler_id: world.wholesalerA,
      trace_no: String(800000000000 + index),
      product_id: product.id,
      weight: 5,
      unit: "kg",
      scan_type: "BARCODE_SCAN",
      status: "NORMAL",
      remaining_weight: 5,
      created_at: new Date(now - (BOXES - index) * 60_000).toISOString(),
    }));

    for (let i = 0; i < scans.length; i += 500) {
      expect((await adminClient().from("inbound_scans").insert(scans.slice(i, i + 500))).error).toBeNull();
    }

    const ledger = scans.map((scan) => ({
      wholesaler_id: world.wholesalerA,
      product_id: product.id,
      inbound_scan_id: scan.id,
      qty_delta: 5,
      event_type: "INBOUND",
      source_type: "inbound_scan",
      source_id: scan.id,
    }));

    for (let i = 0; i < ledger.length; i += 500) {
      expect((await adminClient().from("stock_ledger").insert(ledger.slice(i, i + 500))).error).toBeNull();
    }

    await adminClient().from("products").update({ stock_quantity: BOXES * 5 }).eq("id", product.id);

    const timed = async <T,>(label: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const value = await run();
      const elapsed = performance.now() - started;

      expect(elapsed, `${label} ${Math.round(elapsed)}ms`).toBeLessThan(LIMIT_MS);

      return value;
    };

    const orderId = await world.createOrder({ product, quantity: 40, unitPrice: 15000 });
    const confirmed = await timed("확정(선입선출 배정)", () => updateOrderStatusAction(orderId, "confirmed"));

    expect(confirmed.success, confirmed.error).toBe(true);

    const picking = await timed("피킹 목록", () => import("@/app/dashboard/outbound/actions").then((mod) => mod.getPickingListAction(orderId)));

    expect(picking.data!.length).toBeGreaterThan(0);

    const progress = await timed("진행표", () => getOutboundProgressAction(orderId));

    expect(progress.data).toHaveLength(1);

    const scan = await timed("출고 스캔", () => recordOutboundScanAction(orderId, scans[BOXES - 1].trace_no));

    expect(scan.success, scan.error).toBe(true);

    const { getPickingListAction } = await import("@/app/dashboard/outbound/actions");
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 20 }, () => getPickingListAction(orderId)));
    const elapsed = performance.now() - started;

    expect(results.every((result) => result.success)).toBe(true);
    expect(elapsed, `20명 동시 ${Math.round(elapsed)}ms`).toBeLessThan(LIMIT_MS * 2);
  });
});
