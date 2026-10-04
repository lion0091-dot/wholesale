/**
 * 쪼개기 원가 배분(마이그레이션 231). 지육 원가가 부위 박스와 손실로 나뉘고, 매입 정산은 실제 지출인 부모 박스만 센다.
 * DB 수치 검증은 scripts/db-test-split-scan.sql 이 하고, 여기서는 서버 경로(권한·매입 정산 집계)를 본다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";
import { recordScanAction } from "@/app/dashboard/inbound/actions";

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
