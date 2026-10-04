/**
 * 쪼개기 원가 배분(마이그레이션 231). 지육 원가가 부위 박스와 손실로 나뉘고, 매입 정산은 실제 지출인 부모 박스만 센다.
 * DB 수치 검증은 scripts/db-test-split-scan.sql 이 하고, 여기서는 서버 경로(권한·매입 정산 집계)를 본다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";
import { previewSplitPartsAction, recordScanAction, requestSplitPartPricesAction } from "@/app/dashboard/inbound/actions";

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

async function intakeParent(productId: string, weight: number, unitPrice: number): Promise<string> {
  const traceNo = world.newTraceNo();

  await world.seedTrace(traceNo, { part: "지육" });

  const result = await recordScanAction({
    traceNo,
    weight,
    scanType: "BARCODE_SCAN",
    productId,
    purchaseUnitPrice: unitPrice,
    purchaseSupplier: "납품처A",
  });

  expect(result.success).toBe(true);

  const { data } = await adminClient().from("inbound_scans").select("id").eq("trace_no", traceNo).single();

  return String(data?.id);
}

describe("쪼개기 원가 배분", () => {
  it("지육 원가 = 부위 박스 금액 합 + 손실 금액이고, 매입 정산은 부모 한 곳만 센다", async () => {
    const carcass = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "지육", base_price: 0 });
    const loin = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "등심", base_price: 50000 });
    const tender = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "안심", base_price: 80000 });
    const parentId = await intakeParent(carcass.id, 100, 10000);

    const before = await getActorClient().rpc("summarize_inbound_purchases");

    expect(before.error).toBeNull();

    const split = await getActorClient().rpc("split_inbound_scan", {
      p_scan_id: parentId,
      p_lines: [
        { product_id: loin.id, weight: 40 },
        { product_id: tender.id, weight: 10 },
        { product_id: loin.id, weight: 20 },
      ],
    });

    expect(split.error).toBeNull();
    expect(split.data).toMatchObject({ loss: 30, loss_amount: 300000, price_fallback: [] });

    const { data: children } = await adminClient()
      .from("inbound_scans")
      .select("purchase_amount, purchase_supplier")
      .eq("parent_scan_id", parentId);
    const { data: disposal } = await adminClient()
      .from("box_disposals")
      .select("loss_amount, reason_code")
      .eq("inbound_scan_id", parentId)
      .single();
    const childTotal = (children ?? []).reduce((sum, row) => sum + Number(row.purchase_amount), 0);

    expect(disposal?.reason_code).toBe("YIELD");
    expect(childTotal + Number(disposal?.loss_amount)).toBe(1000000);

    // 매입 정산 합계는 쪼개기 전후가 같다(부위 박스를 또 세지 않는다).
    const after = await getActorClient().rpc("summarize_inbound_purchases");
    const purchaseTotal = (rows: unknown) => Number((rows as Array<{ purchase_total: number | string }>)[0].purchase_total);

    // 합계가 0 == 0이면 아무것도 검증하지 못한 것이다 — 지육 원가(1,000,000)가 실제로 보여야 한다.
    expect(purchaseTotal(before.data)).toBe(1000000);
    expect(purchaseTotal(after.data)).toBe(purchaseTotal(before.data));

    const list = await getActorClient().rpc("list_inbound_purchases", { p_product_id: loin.id });

    expect(list.error).toBeNull();
    expect(list.data).toHaveLength(0);
  });

  it("부위 가격이 없어도 막지 않고 어느 줄이 빠졌는지 돌려준다", async () => {
    const carcass = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "지육", base_price: 0 });
    const noPrice = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "앞다리", base_price: 0 });
    const parentId = await intakeParent(carcass.id, 50, 10000);

    const split = await getActorClient().rpc("split_inbound_scan", {
      p_scan_id: parentId,
      p_lines: [{ product_id: noPrice.id, weight: 40 }],
    });

    expect(split.error).toBeNull();
    expect(split.data).toMatchObject({ price_fallback: [1], loss: 10 });
  });

  it("고객·다른 공급사는 남의 지육을 쪼갤 수 없다", async () => {
    const carcass = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "지육", base_price: 0 });
    const part = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "목심", base_price: 30000 });
    const parentId = await intakeParent(carcass.id, 20, 10000);

    await actAs(world.users.ownerB);
    expect((await getActorClient().rpc("split_inbound_scan", { p_scan_id: parentId, p_lines: [{ product_id: part.id, weight: 10 }] })).error).not.toBeNull();

    await actAs(world.users.retailerR);
    expect((await getActorClient().rpc("split_inbound_scan", { p_scan_id: parentId, p_lines: [{ product_id: part.id, weight: 10 }] })).error).not.toBeNull();

    const { data } = await adminClient().from("inbound_scans").select("remaining_weight, split_at").eq("id", parentId).single();

    expect(Number(data?.remaining_weight)).toBe(20);
    expect(data?.split_at).toBeNull();
  });
});

describe("쪼개기 부위 판매 기본가 미리 보기(마이그 232)", () => {
  it("상품이 있으면 가격, 없으면 NO_PRODUCT를 돌려주고 상품을 만들지 않는다", async () => {
    const attrs = { category: "소", breed: "한우", grade: "1+", origin: "국내산", storage_state: "냉장", stock_quantity: 0 };
    const carcass = await world.createProduct({ ...attrs, subcategory: "지육", base_price: 0 });

    await world.createProduct({ ...attrs, subcategory: "등심", base_price: 40000 });

    const traceNo = world.newTraceNo("0");

    await world.seedTrace(traceNo, { part: "지육", grade: "1+" });

    const scan = await recordScanAction({ traceNo, weight: 30, scanType: "BARCODE_SCAN", productId: carcass.id, purchaseUnitPrice: 10000 });

    expect(scan.success).toBe(true);

    const { data: box } = await adminClient().from("inbound_scans").select("id").eq("trace_no", traceNo).single();
    const before = await adminClient().from("products").select("id", { count: "exact", head: true });
    const preview = await getActorClient().rpc("split_preview_parts", { p_scan_id: box?.id, p_parts: ["등심", "안심"] });

    expect(preview.error).toBeNull();

    const rows = (preview.data ?? []) as Array<{ part: string; status: string; base_price: number | string | null }>;
    const byPart = Object.fromEntries(rows.map((row) => [row.part, row]));

    expect(byPart["등심"]?.status).toBe("OK");
    expect(Number(byPart["등심"]?.base_price)).toBe(40000);
    expect(byPart["안심"]?.status).toBe("NO_PRODUCT");

    // 읽기 전용: 안심 상품을 만들지 않았다.
    const after = await adminClient().from("products").select("id", { count: "exact", head: true });

    expect(after.count).toBe(before.count);
  });

  it("다른 공급사·고객은 남의 박스로 미리 볼 수 없다", async () => {
    const attrs = { category: "소", breed: "한우", grade: "1+", origin: "국내산", storage_state: "냉장", stock_quantity: 0 };
    const carcass = await world.createProduct({ ...attrs, subcategory: "대분할", base_price: 0 });
    const traceNo = world.newTraceNo("0");

    await world.seedTrace(traceNo, { part: "지육", grade: "1+" });
    await recordScanAction({ traceNo, weight: 10, scanType: "BARCODE_SCAN", productId: carcass.id });

    const { data: box } = await adminClient().from("inbound_scans").select("id").eq("trace_no", traceNo).single();

    await actAs(world.users.ownerB);
    expect((await getActorClient().rpc("split_preview_parts", { p_scan_id: box?.id, p_parts: ["등심"] })).error).not.toBeNull();

    await actAs(world.users.retailerR);
    expect((await getActorClient().rpc("split_preview_parts", { p_scan_id: box?.id, p_parts: ["등심"] })).error).not.toBeNull();
  });

  it("서버 액션: 미리 보기는 읽기 전용이고, 사무실 요청은 푸시 기기가 없으면 sent 0으로 알려 준다", async () => {
    const attrs = { category: "소", breed: "한우", grade: "1+", origin: "국내산", storage_state: "냉장", stock_quantity: 0 };
    const carcass = await world.createProduct({ ...attrs, subcategory: "사태", base_price: 0 });
    const traceNo = world.newTraceNo("0");

    await world.seedTrace(traceNo, { part: "사태", grade: "1+" });
    await recordScanAction({ traceNo, weight: 10, scanType: "BARCODE_SCAN", productId: carcass.id });

    const { data: box } = await adminClient().from("inbound_scans").select("id").eq("trace_no", traceNo).single();
    const scanId = String(box?.id);

    const preview = await previewSplitPartsAction(scanId, ["꼬리", "꼬리", " "]);

    expect(preview).toMatchObject({ success: true, data: [{ part: "꼬리", status: "NO_PRODUCT" }] });
    expect(await previewSplitPartsAction(scanId, [])).toEqual({ success: true, data: [] });

    expect(await requestSplitPartPricesAction(scanId, ["꼬리"])).toEqual({ success: true, data: { sent: 0 } });
    expect(await requestSplitPartPricesAction(scanId, [])).toEqual({ success: false, error: "가격을 확인할 부위가 없습니다." });

    await actAs(world.users.ownerB);
    expect(await requestSplitPartPricesAction(scanId, ["꼬리"])).toEqual({ success: false, error: "박스를 찾을 수 없습니다." });
  });
});
