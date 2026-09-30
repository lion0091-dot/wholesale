/**
 * 스캔이 상품을 정하는 순서(마이그레이션 174·175) — 스캔이 모르는 칸(부위·냉장/냉동)은 발주서대로 왔다고 보고 채운다.
 * 재현했던 문제: 냉장으로 지정된 상품이 발주서에 있는데 같은 품목을 스캔하면 냉장 표시 없는 새 상품이 생기고,
 * 발주서 판정이 "발주서에 없는 물건"으로 거절했다. 실제 공공 이력조회는 부위를 주지 않으므로 부위 없는 스캔도 함께 본다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";
import { recordScanAction, resolveMappingAction, resolveScanStorageAction, type ScanResult } from "@/app/dashboard/inbound/actions";

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

async function newSupplier(): Promise<string> {
  const { data, error } = await adminClient()
    .from("suppliers")
    .insert({ wholesaler_id: world.wholesalerA, name: `보관상태-${world.newTraceNo()}` })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  return data.id as string;
}

/** 소 한우 부위·1+ 국내산 상품. 냉장/냉동은 storageState로 지정(null이면 미지정). */
async function newCattleProduct(part: string, storageState: string | null): Promise<string> {
  const { data, error } = await adminClient()
    .from("products")
    .insert({
      wholesaler_id: world.wholesalerA,
      name: `${storageState ?? ""} 한우 ${part} 1+`.trim(),
      category: "소",
      breed: "한우",
      subcategory: part,
      grade: "1+",
      origin: "국내산",
      storage_state: storageState,
      base_price: 0,
      unit: "kg",
      stock_quantity: 0,
      is_active: false,
    })
    .select("id")
    .single();

  if (error) throw new Error(`상품 삽입 실패: ${error.message}`);

  return data.id as string;
}

async function newPurchaseOrder(supplierId: string, lines: Array<{ productId: string; quantity?: number }>): Promise<void> {
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
      category: "소",
      origin: "국내산",
      quantity: line.quantity ?? 100,
      unit: "kg",
      product_id: line.productId,
    }))
  );

  if (lineError) throw new Error(lineError.message);
}

/** part가 null이면 실제 공공 이력조회처럼 부위를 모르는 박스다. */
async function scanBox(
  part: string | null,
  supplierId: string | null,
  weight = 20,
  hints: { partHint?: string; storageHint?: "냉장" | "냉동" } = {}
): Promise<ScanResult> {
  const traceNo = world.newTraceNo();

  await world.seedTrace(traceNo, { part, grade: "1+" });

  const result = await recordScanAction({ traceNo, weight, scanType: "MANUAL", ...(supplierId ? { supplierId } : {}), ...hints });

  expect(result.success, result.error).toBe(true);

  return result.data as ScanResult;
}

async function productsOfPart(part: string) {
  const { data } = await adminClient()
    .from("products")
    .select("id, storage_state")
    .eq("wholesaler_id", world.wholesalerA)
    .eq("subcategory", part);

  return (data ?? []) as Array<{ id: string; storage_state: string | null }>;
}

async function unspecifiedCattleCount(): Promise<number> {
  const { count } = await adminClient()
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("wholesaler_id", world.wholesalerA)
    .is("subcategory", null);

  return count ?? 0;
}

describe("스캔 — 발주서가 스캔이 모르는 칸을 채운다(174·175)", () => {
  it("부위를 모르는 박스(실제 이력조회)도 발주서에 그 고기가 하나뿐이면 발주서 상품(부위·냉장)에 붙어 줄을 채운다", async () => {
    const part = `부위모름-${world.runId}`;
    const supplierId = await newSupplier();
    const productId = await newCattleProduct(part, "냉장");
    const before = await unspecifiedCattleCount();

    await newPurchaseOrder(supplierId, [{ productId }]);

    const scan = await scanBox(null, supplierId);

    expect(scan.productId).toBe(productId);
    expect(scan.status).toBe("NORMAL");
    expect(scan.po).toMatchObject({ result: "ASSIGNED", ordered: 100, received: 20 });
    expect(await unspecifiedCattleCount()).toBe(before);
  });

  it("부위를 아는 박스도 발주서 상품이 냉장으로 지정돼 있으면 새 상품을 만들지 않고 그 상품에 붙는다", async () => {
    const part = `발주우선-${world.runId}`;
    const supplierId = await newSupplier();
    const productId = await newCattleProduct(part, "냉장");

    await newPurchaseOrder(supplierId, [{ productId }]);

    const scan = await scanBox(part, supplierId);

    expect(scan.productId).toBe(productId);
    expect(scan.po).toMatchObject({ result: "ASSIGNED" });
    expect(await productsOfPart(part)).toHaveLength(1);
  });

  it("발주서에 냉장·냉동이 둘 다 있으면 자동으로 정하지 않고 '확인 필요'로 남긴다. 보류·거절이 아니고 후보 둘만 나오며, 고르면 그 상품에 붙는다", async () => {
    const part = `냉장냉동-${world.runId}`;
    const supplierId = await newSupplier();
    const chilled = await newCattleProduct(part, "냉장");
    const frozen = await newCattleProduct(part, "냉동");

    await newPurchaseOrder(supplierId, [{ productId: chilled }, { productId: frozen }]);

    const scan = await scanBox(part, supplierId);

    expect(scan.status).toBe("PENDING_MAPPING");
    expect(scan.productId).toBeNull();
    expect(await productsOfPart(part)).toHaveLength(2);

    const { data: row } = await adminClient().from("inbound_scans").select("po_state, status").eq("id", scan.scanId).single();

    expect(row).toMatchObject({ status: "PENDING_MAPPING", po_state: null });

    const { data: candidates, error } = await getActorClient().rpc("scan_po_candidates", { p_scan_id: scan.scanId });

    expect(error).toBeNull();
    expect(((candidates ?? []) as Array<{ product_id: string }>).map((item) => item.product_id).sort()).toEqual([chilled, frozen].sort());

    const resolved = await resolveMappingAction(scan.scanId, frozen, false);

    expect(resolved.success, resolved.error).toBe(true);

    const { data: after } = await adminClient().from("inbound_scans").select("product_id, status, po_state").eq("id", scan.scanId).single();

    expect(after).toMatchObject({ product_id: frozen, status: "NORMAL", po_state: "ASSIGNED" });
  });

  it("후보를 고를 때 박스에 상품코드(GTIN)가 있었으면 그 코드는 학습된다 — 같은 코드의 다음 박스는 되묻지 않고 그 상품(냉장/냉동 포함)으로 간다", async () => {
    const part = `코드학습-${world.runId}`;
    const gtin = String(Math.floor(Math.random() * 1e13)).padStart(14, "8");
    const supplierId = await newSupplier();
    const chilled = await newCattleProduct(part, "냉장");
    const frozen = await newCattleProduct(part, "냉동");

    await newPurchaseOrder(supplierId, [{ productId: chilled }, { productId: frozen }]);

    const traceA = world.newTraceNo();

    await world.seedTrace(traceA, { part, grade: "1+" });

    const first = await recordScanAction({ traceNo: traceA, weight: 20, scanType: "MANUAL", supplierId, gtin });

    expect(first.success, first.error).toBe(true);
    expect((first.data as ScanResult).status).toBe("PENDING_MAPPING");
    expect((await resolveMappingAction((first.data as ScanResult).scanId, frozen, false)).success).toBe(true);

    const { data: learned } = await adminClient().from("gtin_product_map").select("product_id").eq("wholesaler_id", world.wholesalerA).eq("gtin", gtin).single();

    expect(learned?.product_id).toBe(frozen);

    const traceB = world.newTraceNo();

    await world.seedTrace(traceB, { part, grade: "1+" });

    const second = await recordScanAction({ traceNo: traceB, weight: 25, scanType: "MANUAL", supplierId, gtin });
    const secondData = second.data as ScanResult;

    expect(secondData.status).toBe("NORMAL");
    expect(secondData.productId).toBe(frozen);
    expect(secondData.po).toMatchObject({ result: "ASSIGNED" });
  });

  it("부위를 모르는 박스에 발주서의 서로 다른 부위 상품이 둘이면 마찬가지로 '확인 필요'다", async () => {
    const supplierId = await newSupplier();
    const a = await newCattleProduct(`등심-${world.runId}`, "냉장");
    const b = await newCattleProduct(`안심-${world.runId}`, "냉장");
    const before = await unspecifiedCattleCount();

    await newPurchaseOrder(supplierId, [{ productId: a }, { productId: b }]);

    const scan = await scanBox(null, supplierId);

    expect(scan.status).toBe("PENDING_MAPPING");
    expect(await unspecifiedCattleCount()).toBe(before);
  });

  it("박스 라벨을 보고 입력한 냉장/냉동으로 발주서 후보가 하나로 좁혀지면 되묻지 않고 그 상품에 붙는다", async () => {
    const part = `입력냉장-${world.runId}`;
    const supplierId = await newSupplier();
    const chilled = await newCattleProduct(part, "냉장");
    const frozen = await newCattleProduct(part, "냉동");

    await newPurchaseOrder(supplierId, [{ productId: chilled }, { productId: frozen }]);

    const scan = await scanBox(part, supplierId, 20, { storageHint: "냉동" });

    expect(scan.status).toBe("NORMAL");
    expect(scan.productId).toBe(frozen);
    expect(scan.po).toMatchObject({ result: "ASSIGNED" });
  });

  it("이력조회가 부위를 안 준 박스에 입력한 부위로 발주서의 여러 부위 중 하나가 정해진다", async () => {
    const supplierId = await newSupplier();
    const a = await newCattleProduct(`입력등심-${world.runId}`, "냉장");
    const b = await newCattleProduct(`입력안심-${world.runId}`, "냉장");

    await newPurchaseOrder(supplierId, [{ productId: a }, { productId: b }]);

    const scan = await scanBox(null, supplierId, 20, { partHint: `입력안심-${world.runId}` });

    expect(scan.status).toBe("NORMAL");
    expect(scan.productId).toBe(b);
  });

  it("발주서에도 상품에도 없으면 입력한 부위·냉장/냉동으로 상품을 만들고(이름 앞에 냉장), 같은 입력의 다음 박스는 그 상품을 다시 쓴다", async () => {
    const part = `입력생성-${world.runId}`;

    const first = await scanBox(null, null, 20, { partHint: part, storageHint: "냉장" });
    const created = await productsOfPart(part);

    expect(created).toHaveLength(1);
    expect(created[0].storage_state).toBe("냉장");
    expect(first.productId).toBe(created[0].id);

    const { data: product } = await adminClient().from("products").select("name").eq("id", created[0].id).single();

    expect(product?.name).toBe(`냉장 한우 ${part} 1+`);

    const second = await scanBox(null, null, 25, { partHint: part, storageHint: "냉장" });

    expect(second.productId).toBe(first.productId);
    expect(await productsOfPart(part)).toHaveLength(1);
  });

  it("한쪽 줄이 이미 다 찼으면 남은 쪽으로 자동으로 정한다", async () => {
    const part = `다참-${world.runId}`;
    const supplierId = await newSupplier();
    const chilled = await newCattleProduct(part, "냉장");
    const frozen = await newCattleProduct(part, "냉동");

    await newPurchaseOrder(supplierId, [{ productId: chilled, quantity: 20 }, { productId: frozen, quantity: 100 }]);

    const first = await scanBox(part, supplierId, 20);

    expect(first.status).toBe("PENDING_MAPPING");
    // 후보를 고른 결정은 기억하지 않는다(remember=false) — 기억하면 다음 박스가 발주서를 보지 않고 같은 상품으로 간다.
    expect((await resolveMappingAction(first.scanId, chilled, false)).success).toBe(true);

    const second = await scanBox(part, supplierId, 20);

    expect(second.productId).toBe(frozen);
    expect(second.po).toMatchObject({ result: "ASSIGNED" });
  });

  it("발주서가 없어도 냉장/냉동이 지정된 상품이 하나뿐이면 그 상품에 붙는다", async () => {
    const part = `후보하나-${world.runId}`;
    const productId = await newCattleProduct(part, "냉동");

    const scan = await scanBox(part, null);

    expect(scan.productId).toBe(productId);
    expect(await productsOfPart(part)).toHaveLength(1);
  });

  it("발주서가 없고 냉장·냉동 상품이 둘 다 있으면 자동으로 정하지 않고 냉장/냉동을 사람이 고르게 한다(상품을 새로 만들지 않는다)", async () => {
    const part = `후보둘-${world.runId}`;

    await newCattleProduct(part, "냉장");
    await newCattleProduct(part, "냉동");

    const scan = await scanBox(part, null);

    expect(scan.status).toBe("PENDING_MAPPING");
    expect(scan.productId).toBeNull();
    expect(await productsOfPart(part)).toHaveLength(2);
  });

  it("냉장/냉동을 끝내 못 정한 박스는 보관되고, 사람이 냉장/냉동을 고르면 그 값의 상품이 만들어져 입고된다(빈 냉장/냉동 상품은 만들지 않는다)", async () => {
    const part = `냉장고르기-${world.runId}`;
    const scan = await scanBox(part, null);

    expect(scan.status).toBe("PENDING_MAPPING");
    expect(await productsOfPart(part)).toHaveLength(0);

    await actAs(world.users.ownerA);

    const resolved = await resolveScanStorageAction(scan.scanId, "냉동", part);

    expect(resolved.success, resolved.error).toBe(true);
    expect(resolved.data?.status).toBe("NORMAL");

    const products = await productsOfPart(part);

    expect(products).toHaveLength(1);
    expect(products[0].storage_state).toBe("냉동");

    const { data: after } = await adminClient().from("inbound_scans").select("status, product_id").eq("id", scan.scanId).single();

    expect(after).toMatchObject({ status: "NORMAL", product_id: products[0].id });
  });

  it("냉장/냉동이 없는 축종(양)은 냉장/냉동을 묻지 않고 그대로 자동 생성된다", async () => {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: `양다리-${world.runId}`, grade: null, speciesGroup: "양" });

    const result = await recordScanAction({ traceNo, weight: 5, scanType: "MANUAL", storageHint: "냉장" });

    expect(result.success, result.error).toBe(true);
    expect((result.data as ScanResult).status).toBe("NORMAL");

    const { data: product } = await adminClient().from("products").select("storage_state").eq("id", (result.data as ScanResult).productId!).single();

    expect(product?.storage_state).toBeNull();
  });

  it("발주서가 있는 거래처인데 맞는 상품이 하나도 없으면 새 상품을 만들지 않고 보관한다. 드롭박스는 그 거래처 열린 발주서 상품만 보여 주고, 고르면 그 상품에 붙는다", async () => {
    const part = `진짜없음-${world.runId}`;
    const supplierId = await newSupplier();
    const other = await newCattleProduct(`다른부위-${world.runId}`, "냉장");

    await newPurchaseOrder(supplierId, [{ productId: other }]);

    const scan = await scanBox(part, supplierId);

    expect(scan.status).toBe("PENDING_MAPPING");
    expect(scan.productId).toBeNull();
    expect(await productsOfPart(part)).toHaveLength(0);

    const { data: open, error } = await getActorClient().rpc("scan_open_po_products", { p_scan_id: scan.scanId });

    expect(error).toBeNull();
    expect(((open ?? []) as Array<{ product_id: string }>).map((item) => item.product_id)).toEqual([other]);

    const resolved = await resolveMappingAction(scan.scanId, other, false);

    expect(resolved.success, resolved.error).toBe(true);

    const { data: after } = await adminClient().from("inbound_scans").select("product_id, status, po_state").eq("id", scan.scanId).single();

    expect(after).toMatchObject({ product_id: other, status: "NORMAL", po_state: "ASSIGNED" });
  });

  it("부위를 잘못 입력(오타)하면 오타 상품이 생기지 않고 보관된다", async () => {
    const supplierId = await newSupplier();
    const right = await newCattleProduct(`정타-${world.runId}`, "냉장");

    await newPurchaseOrder(supplierId, [{ productId: right }]);

    const scan = await scanBox(null, supplierId, 20, { partHint: `오타-${world.runId}`, storageHint: "냉장" });

    expect(scan.status).toBe("PENDING_MAPPING");
    expect(await productsOfPart(`오타-${world.runId}`)).toHaveLength(0);
  });
});
