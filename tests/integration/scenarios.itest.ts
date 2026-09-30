/**
 * 시나리오 테스트 — 사용자가 실제로 밟는 순서대로 여러 기능을 이어 붙여 본다.
 * 기능별 세부 케이스는 inbound/products/outbound.itest.ts가 이미 한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World, type WorldProduct } from "./harness";
import { recordScanAction, type ScanResult } from "@/app/dashboard/inbound/actions";
import { createProductAction, updateProductAction } from "@/app/dashboard/products/actions";
import { updateOrderStatusAction } from "@/app/dashboard/orders/actions";

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

function newProduct(overrides: Record<string, unknown> = {}): Promise<WorldProduct> {
  return world.createProduct({ stock_quantity: 0, category: "소", subcategory: "등심", ...overrides });
}

async function stockOf(productId: string): Promise<number> {
  const { data } = await adminClient().from("products").select("stock_quantity").eq("id", productId).single();

  return Number(data?.stock_quantity);
}

describe("SC-3 상품 중복 제어 — 스캔 자동 생성 → 같은 키 손 등록 거부 → 수정으로 겹치기 차단 → DB가 마지막으로 막음", () => {
  const part = () => `채끝-${world.runId}`;

  function productForm(fields: Record<string, string>): FormData {
    const data = new FormData();
    const defaults: Record<string, string> = { name: "", category: "가공육", subcategory: "", origin: "국내산", storage_state: "냉장", base_price: "5000", stock_quantity: "0" };

    for (const [key, value] of Object.entries({ ...defaults, ...fields })) data.set(key, value);

    return data;
  }

  it("같은 소 부위·등급의 박스를 여러 번 찍어도 상품은 하나이고, 다른 경로로는 같은 상품을 못 만든다", async () => {
    const p = part();
    const traces = [world.newTraceNo(), world.newTraceNo(), world.newTraceNo()];
    const productIds = new Set<string>();

    for (const traceNo of traces) {
      await world.seedTrace(traceNo, { part: p, grade: "1+" });
      const result = await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN", storageHint: "냉장" });

      expect(result.success).toBe(true);
      productIds.add((result.data as ScanResult).productId!);
    }

    expect(productIds.size).toBe(1);

    const { data: same } = await adminClient()
      .from("products")
      .select("id, name")
      .eq("wholesaler_id", world.wholesalerA)
      .eq("category", "소")
      .eq("subcategory", p)
      .eq("grade", "1+");

    expect(same).toHaveLength(1);
    expect(same![0].name).toBe(`냉장 한우 ${p} 1+`);
    expect(await stockOf([...productIds][0])).toBeCloseTo(12);

    // (a) 상품 관리 화면에서 소를 손으로 등록하려면 성별·냉장/냉동이 필수라(160) 성별·냉장냉동이 비어 자동 생성된 스캔 상품과는 키가 다르다.
    //     같은 키로 두 번 등록하면 두 번째는 거부된다.
    const manualFields = { category: "소", breed: "한우", subcategory: p, grade: "1+", sex: "거세", storage_state: "냉장", name: "" };
    const manual = await createProductAction(productForm(manualFields));
    const manualAgain = await createProductAction(productForm(manualFields));

    expect(manual.success).toBe(true);
    expect(manualAgain.success).toBe(false);
    expect(manualAgain.error).toContain("이미 같은 상품이 등록되어 있습니다");

    // (b) 돼지·닭·오리·계란도 미리 손으로 등록할 수 있고(상품명은 자동 조합), 같은 키를 다시 등록하면 거부, 가공육·양은 키가 없어 그대로 등록된다
    expect((await createProductAction(productForm({ category: "돼지", subcategory: "삼겹살", origin: "스페인산", name: "손 삼겹" }))).success).toBe(true);
    expect((await createProductAction(productForm({ category: "돼지", subcategory: "삼겹살", origin: "스페인산", name: "손 삼겹2" }))).success).toBe(false);
    expect((await createProductAction(productForm({ category: "닭", origin: "스페인산", name: "손 닭" }))).success).toBe(true);
    expect((await createProductAction(productForm({ category: "오리", origin: "스페인산", name: "손 오리" }))).success).toBe(true);
    expect((await createProductAction(productForm({ category: "가공육", subcategory: "소시지", name: "손 소시지" }))).success).toBe(true);
    expect((await createProductAction(productForm({ category: "양", subcategory: "", name: "양 다리" }))).success).toBe(true);

    // (c) 부위·등급이 비어 자동 생성된 상품을 수정으로 채우다가 이미 있는 키와 같아지면 거부
    const blank = await world.createProduct({ category: "소", subcategory: null, grade: null, origin: "국내산", name: "(부위 미지정)" });
    const clash = await updateProductAction(blank.id, productForm({ category: "소", breed: "한우", subcategory: p, grade: "1+", sex: "거세", origin: "국내산" }));

    expect(clash.success).toBe(false);
    expect(clash.error).toContain("이미 같은 상품이 등록되어 있습니다");

    // (d) 앱 검사를 우회해 DB에 직접 넣어도 유니크 인덱스가 막는다
    const raw = await adminClient().from("products").insert({
      wholesaler_id: world.wholesalerA,
      name: "직접 삽입",
      category: "소",
      breed: "한우",
      subcategory: p,
      grade: "1+",
      origin: "국내산",
      storage_state: "냉장",
      base_price: 0,
      unit: "kg",
      stock_quantity: 0,
      is_active: false,
    });

    expect(raw.error?.code).toBe("23505");
  });

  it("다른 공급사는 같은 키의 소 상품을 가질 수 있다(공급사별 유니크)", async () => {
    const p = part();
    const { data, error } = await adminClient()
      .from("products")
      .insert({ wholesaler_id: world.wholesalerB, name: "B사 상품", category: "소", subcategory: p, grade: "1+", origin: "국내산", base_price: 0, unit: "kg", stock_quantity: 0, is_active: false })
      .select("id")
      .single();

    expect(error).toBeNull();
    await adminClient().from("products").delete().eq("id", data!.id);
  });
});

describe("SC-4 주문 → 출고 → 고객이 받는 거래명세서 이력번호·출고 라벨 (세트 제거 후에도 그대로 나온다)", () => {
  it("입고 박스 2개 → 주문 확정(선입선출 배정) → 고객·공급사가 이력번호를 조회하고 남의 공급사는 못 본다", async () => {
    const product = await newProduct({ base_price: 15000 });
    const boxA = world.newTraceNo();
    const boxB = world.newTraceNo();

    await world.seedTrace(boxA, { part: "등심" });
    await world.seedTrace(boxB, { part: "등심" });
    expect((await recordScanAction({ traceNo: boxA, weight: 5, scanType: "BARCODE_SCAN", productId: product.id })).success).toBe(true);
    expect((await recordScanAction({ traceNo: boxB, weight: 5, scanType: "BARCODE_SCAN", productId: product.id })).success).toBe(true);

    const orderId = await world.createOrder({ product, quantity: 6, unitPrice: 15000 });

    expect((await updateOrderStatusAction(orderId, "confirmed")).success).toBe(true);
    expect(await stockOf(product.id)).toBeCloseTo(4);

    // 고객(주문한 식당): 거래명세서에 실리는 이력번호 목록
    await actAs(world.users.retailerR);
    const mine = await getActorClient().rpc("get_order_trace_numbers", { p_order_id: orderId });

    expect(mine.error).toBeNull();

    const rows = (mine.data ?? []) as Array<{ trace_no: string; quantity: number }>;

    expect(new Set(rows.map((row) => row.trace_no))).toEqual(new Set([boxA, boxB]));
    expect(rows.reduce((sum, row) => sum + Number(row.quantity), 0)).toBeCloseTo(6);

    // 공급사: 출고 라벨 — 세트 열(is_bundle 등)은 이제 없다
    await actAs(world.users.ownerA);
    const labels = await getActorClient().rpc("get_order_labels", { p_order_id: orderId });

    expect(labels.error).toBeNull();
    expect((labels.data as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
    expect(Object.keys((labels.data as Array<Record<string, unknown>>)[0])).not.toContain("is_bundle");

    // 재고 원장 요약: 세트투입 칸 없이 4개 합계
    const summary = await getActorClient().rpc("summarize_stock_ledger", { p_wholesaler_id: world.wholesalerA });

    expect(summary.error).toBeNull();
    expect(Object.keys((summary.data as Array<Record<string, unknown>>)[0]).sort()).toEqual(["adjustment_qty", "inbound_qty", "loss_qty", "outbound_qty"]);

    // 다른 공급사 사장은 이 주문의 이력번호·라벨을 못 본다
    await actAs(world.users.ownerB);
    const stranger = await getActorClient().rpc("get_order_trace_numbers", { p_order_id: orderId });
    const strangerLabels = await getActorClient().rpc("get_order_labels", { p_order_id: orderId });

    expect(stranger.data ?? []).toHaveLength(0);
    expect(strangerLabels.data ?? []).toHaveLength(0);
  });
});
