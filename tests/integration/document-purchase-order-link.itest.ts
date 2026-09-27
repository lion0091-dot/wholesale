/**
 * 전표 ↔ 발주서 연결(마이그레이션 143) — 서버 액션을 통해 끝까지: 발주서에 없거나 초과로 받은 물건을
 * "발주서 추가 생성"으로 사후 등록하고, 전표에 거래처를 붙인다.
 * DB 함수의 세부(guard·격리)는 scripts/db-test-document-purchase-order-link.sql이 한다 — 여기는 액션과의 이음새를 본다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";
import { recordScanAction, type ScanResult } from "@/app/dashboard/inbound/actions";
import { createPurchaseOrderFromUnlistedScanAction } from "@/app/dashboard/inbound/actions";
import {
  createPurchaseOrderFromDocumentScanAction,
  linkScanToDocumentLineAction,
  setDocumentSupplierAction,
} from "@/app/dashboard/inbound/document-actions";

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

async function scan(traceNo: string, weight: number, product: WorldProduct, supplierId?: string): Promise<ScanResult> {
  await world.seedTrace(traceNo, { part: "등심" });
  const result = await recordScanAction({ traceNo, weight, scanType: "MANUAL", productId: product.id, supplierId });

  expect(result.success, result.error).toBe(true);

  return result.data as ScanResult;
}

async function scanRow(traceNo: string) {
  const { data } = await adminClient()
    .from("inbound_scans")
    .select("id, po_state, status")
    .eq("wholesaler_id", world.wholesalerA)
    .eq("trace_no", traceNo)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return data as { id: string; po_state: string | null; status: string };
}

describe("createPurchaseOrderFromUnlistedScanAction — 보류함", () => {
  it("UNLISTED_HELD 박스를 발주서 추가 생성하면 발주서·전표가 같이 만들어지고 스캔은 ASSIGNED", async () => {
    await adminClient()
      .from("receiving_policies")
      .upsert({ wholesaler_id: world.wholesalerA, unlisted_item_policy: "HOLD" }, { onConflict: "wholesaler_id" });

    const supplierId = await newSupplier("보류함공급처");
    const product = await world.createProduct({ stock_quantity: 0 });
    const trace = world.newTraceNo();

    const first = await scan(trace, 12, product, supplierId);

    expect(first.po).toMatchObject({ result: "UNLISTED_HELD" });

    const row = await scanRow(trace);
    const result = await createPurchaseOrderFromUnlistedScanAction(row.id);

    expect(result.success, result.error).toBe(true);
    expect(result.data).toMatchObject({ amount: 12 });
    expect(result.data!.documentId).not.toBeNull();

    const { data: order } = await adminClient()
      .from("purchase_orders")
      .select("status, auto_closed_at, purchase_order_lines(quantity, product_id)")
      .eq("id", result.data!.orderId)
      .single();

    expect(order).toMatchObject({ status: "CLOSED" });
    expect(order!.auto_closed_at).not.toBeNull();
    expect(order!.purchase_order_lines).toMatchObject([{ quantity: 12, product_id: product.id }]);

    expect((await scanRow(trace)).po_state).toBe("ASSIGNED");
  });

  it("직원(staff)은 발주서 추가 생성을 할 수 없다", async () => {
    await adminClient()
      .from("receiving_policies")
      .upsert({ wholesaler_id: world.wholesalerA, unlisted_item_policy: "HOLD" }, { onConflict: "wholesaler_id" });

    const supplierId = await newSupplier("직원거부공급처");
    const product = await world.createProduct({ stock_quantity: 0 });
    const trace = world.newTraceNo();

    await scan(trace, 5, product, supplierId);
    const row = await scanRow(trace);

    await actAs(world.users.staffA);
    const result = await createPurchaseOrderFromUnlistedScanAction(row.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain("사장님·매니저만");
  });

  it("이미 전표에 이어진 박스는 보류함 경로로 등록할 수 없다(전표 대조 화면을 쓰라고 안내)", async () => {
    await adminClient()
      .from("receiving_policies")
      .upsert({ wholesaler_id: world.wholesalerA, unlisted_item_policy: "HOLD" }, { onConflict: "wholesaler_id" });

    const supplierId = await newSupplier("전표선점공급처");
    const product = await world.createProduct({ stock_quantity: 0 });
    const trace = world.newTraceNo();

    await scan(trace, 5, product, supplierId);
    const row = await scanRow(trace);

    const { data: doc } = await adminClient()
      .from("inbound_documents")
      .insert({ wholesaler_id: world.wholesalerA, supplier_id: supplierId, supplier_name: "테스트", status: "PENDING", entry_method: "MANUAL" })
      .select("id")
      .single();
    const { data: line } = await adminClient()
      .from("inbound_document_lines")
      .insert({ document_id: doc!.id, line_no: 1, item_name: "테스트", product_id: product.id })
      .select("id")
      .single();

    const linkResult = await linkScanToDocumentLineAction(row.id, line!.id);

    expect(linkResult.success, linkResult.error).toBe(true);

    const result = await createPurchaseOrderFromUnlistedScanAction(row.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain("전표에 이어져 있습니다");
  });
});

describe("createPurchaseOrderFromDocumentScanAction·setDocumentSupplierAction — 전표 대조", () => {
  it("전표에 거래처를 붙이고, 거래처 없이 찍힌 박스를 그 전표의 발주서로 등록한다", async () => {
    const supplierId = await newSupplier("전표대조공급처");
    const product = await world.createProduct({ stock_quantity: 0 });
    const trace = world.newTraceNo();

    // 거래처 없이 찍음 — 판정이 아예 안 일어난다(supplier_id 없어 스킵).
    const scanResult = await scan(trace, 9, product);

    expect(scanResult.po ?? null).toBeNull();

    const row = await scanRow(trace);

    const { data: doc } = await adminClient()
      .from("inbound_documents")
      .insert({ wholesaler_id: world.wholesalerA, supplier_name: "테스트", status: "PENDING", entry_method: "MANUAL" })
      .select("id")
      .single();
    const { data: line } = await adminClient()
      .from("inbound_document_lines")
      .insert({ document_id: doc!.id, line_no: 1, item_name: "테스트", product_id: product.id })
      .select("id")
      .single();

    const linkResult = await linkScanToDocumentLineAction(row.id, line!.id);

    expect(linkResult.success, linkResult.error).toBe(true);

    // 거래처를 아직 안 붙였으니 거부된다.
    const beforeSupplier = await createPurchaseOrderFromDocumentScanAction(row.id);

    expect(beforeSupplier.success).toBe(false);
    expect(beforeSupplier.error).toContain("거래처가 아직 없습니다");

    const setResult = await setDocumentSupplierAction(doc!.id, supplierId);

    expect(setResult.success, setResult.error).toBe(true);

    const afterSupplier = await createPurchaseOrderFromDocumentScanAction(row.id);

    expect(afterSupplier.success, afterSupplier.error).toBe(true);
    expect(afterSupplier.data).toMatchObject({ amount: 9, documentId: null });

    const { data: order } = await adminClient()
      .from("purchase_orders")
      .select("status, supplier_id")
      .eq("id", afterSupplier.data!.orderId)
      .single();

    expect(order).toMatchObject({ status: "CLOSED", supplier_id: supplierId });
  });

  it("직원은 전표 거래처를 바꿀 수 없다", async () => {
    const { data: doc } = await adminClient()
      .from("inbound_documents")
      .insert({ wholesaler_id: world.wholesalerA, supplier_name: "테스트", status: "PENDING", entry_method: "MANUAL" })
      .select("id")
      .single();
    const supplierId = await newSupplier("직원거부전표공급처");

    await actAs(world.users.staffA);
    const result = await setDocumentSupplierAction(doc!.id, supplierId);

    expect(result.success).toBe(false);
    expect(result.error).toContain("사장님·매니저만");
  });
});
