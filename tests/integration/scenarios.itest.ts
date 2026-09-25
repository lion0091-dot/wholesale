/**
 * 시나리오 테스트 — 2026-09-25 입고 자동화(명세서 대조·지금 할 일 카드·스캔 종료)부터 상품 중복 제어(소 유니크·손 등록 차단)까지
 * 사용자가 실제로 밟는 순서대로 여러 기능을 이어 붙여 본다. 기능별 세부 케이스는 inbound/documents/products/outbound.itest.ts가 이미 한다.
 * 시나리오 목록·기대 결과는 docs/inbound-scenario-tests.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World, type WorldProduct } from "./harness";
import { recordScanAction, voidScanAction, type ScanResult } from "@/app/dashboard/inbound/actions";
import {
  closeInboundDocumentAction,
  reopenInboundDocumentAction,
  setDocumentsScanFinishedAction,
} from "@/app/dashboard/inbound/document-actions";
import { createProductAction, updateProductAction } from "@/app/dashboard/products/actions";
import { updateOrderStatusAction } from "@/app/dashboard/orders/actions";
import { documentLineExpectedQty, documentLineMatchStatus } from "@/lib/livestock/document-reconciliation";
import { pickInboundNextStep } from "@/lib/livestock/inbound-next-step";

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

async function scan(traceNo: string, weight: number) {
  await world.seedTrace(traceNo, { part: "등심" });

  const result = await recordScanAction({ traceNo, weight, scanType: "BARCODE_SCAN" });

  expect(result.success).toBe(true);

  return result.data as ScanResult;
}

async function docStatus(documentId: string) {
  const { data } = await adminClient().from("inbound_documents").select("status").eq("id", documentId).single();

  return String(data?.status);
}

/** 화면(page.tsx)이 카드 판단에 넘기는 값을 DB에서 다시 계산한다 — 줄마다 예정 수량과 이어진(취소 제외) 박스 수. */
async function cardStep(documentId: string, scanFinished: boolean) {
  const { data: lines } = await adminClient().from("inbound_document_lines").select("id, quantity").eq("document_id", documentId);
  let complete = 0;
  let remaining = 0;

  for (const line of (lines ?? []) as Array<{ id: string; quantity: number | null }>) {
    const { data: links } = await adminClient()
      .from("inbound_document_line_scans")
      .select("scan_id, inbound_scans(status)")
      .eq("line_id", line.id);
    const linked = ((links ?? []) as Array<{ inbound_scans: { status: string } | { status: string }[] | null }>).filter((link) => {
      const s = Array.isArray(link.inbound_scans) ? link.inbound_scans[0] : link.inbound_scans;

      return s?.status !== "VOIDED";
    }).length;
    const expected = documentLineExpectedQty(line.quantity === null ? null : Number(line.quantity));

    if (documentLineMatchStatus(expected, linked) === "COMPLETE") complete += 1;
    if (linked < expected) remaining += expected - linked;
  }

  return pickInboundNextStep({
    pendingDocuments: [{ id: documentId, scanFinished, completeLines: complete, totalLines: (lines ?? []).length }],
    remainingBoxCount: remaining,
    needsCheckScanCount: 0,
  }).key;
}

describe("SC-1 정상 하루 — 명세서 올리기 → 현장 스캔이 명세서와 저절로 이어짐 → 전부 도착 → 카드에서 마감", () => {
  it("명세서 2줄 → 박스 2개 → 재고는 스캔이 만들고, 마감은 재고를 안 바꾼다", async () => {
    const product = await newProduct();
    const traceA = world.newTraceNo();
    const traceB = world.newTraceNo();
    const first = await world.createDocumentLine({ traceNo: traceA, product, quantity: 1 });

    await world.createDocumentLine({ traceNo: traceB, product, quantity: 1, documentId: first.documentId });

    // 스캔 전: 카드는 "현장에서 스캔 중" 단계이고 명세서를 올렸어도 재고는 0이다
    expect(await cardStep(first.documentId, false)).toBe("scan");
    expect(await stockOf(product.id)).toBe(0);

    // 현장: 상품을 고르지 않고 바코드만 찍는다 — 명세서 줄이 상품을 정해 준다
    const a = await scan(traceA, 12.5);

    expect(a.status).toBe("NORMAL");
    expect(a.productId).toBe(product.id);
    expect(await cardStep(first.documentId, false)).toBe("scan");

    const b = await scan(traceB, 9.8);

    expect(b.productId).toBe(product.id);
    expect(await stockOf(product.id)).toBeCloseTo(22.3);

    const { data: links } = await adminClient().from("inbound_document_line_scans").select("scan_id").in("scan_id", [a.scanId, b.scanId]);

    expect(links).toHaveLength(2);

    // 전부 도착 → 카드는 "전부 입고 완료 → 마감하기"
    expect(await cardStep(first.documentId, false)).toBe("close");

    // 카드에서 바로 마감 — 사유 없이 되고, 재고는 그대로다
    expect(await closeInboundDocumentAction(first.documentId, null)).toEqual({ success: true, data: { incompleteLines: 0 } });
    expect(await docStatus(first.documentId)).toBe("CLOSED");
    expect(await stockOf(product.id)).toBeCloseTo(22.3);
  });
});

describe("SC-2 결품 — 박스가 끝내 다 안 옴 → 현장 스캔 종료 → 사무실이 사유 적고 마감 → 늦게 온 박스가 있으면 다시 열기", () => {
  it("스캔 종료 표시는 재고를 안 바꾸고, 마감은 사유가 있어야 하며, 다시 열면 늦은 박스가 다시 이어진다", async () => {
    const product = await newProduct();
    const [t1, t2, t3] = [world.newTraceNo(), world.newTraceNo(), world.newTraceNo()];
    const first = await world.createDocumentLine({ traceNo: t1, product, quantity: 1 });

    await world.createDocumentLine({ traceNo: t2, product, quantity: 1, documentId: first.documentId });
    await world.createDocumentLine({ traceNo: t3, product, quantity: 1, documentId: first.documentId });

    await scan(t1, 10);
    await scan(t2, 8);

    // 3줄 중 1줄이 안 옴 — 현장이 아직 종료를 안 눌렀으면 사무실 카드는 대기
    expect(await cardStep(first.documentId, false)).toBe("scan");

    // 현장: "스캔 종료" → 사무실 카드가 "확인·마감하기"로 바뀐다. 재고는 그대로.
    expect(await setDocumentsScanFinishedAction([first.documentId], true)).toEqual({ success: true, data: { changed: 1 } });
    expect(await cardStep(first.documentId, true)).toBe("scan-finished");
    expect(await stockOf(product.id)).toBeCloseTo(18);

    // 사무실: 사유 없이는 마감 불가, 사유를 적으면 마감(미입고 1줄)
    expect(await closeInboundDocumentAction(first.documentId, null)).toEqual({
      success: false,
      error: "미입고 1줄이 있어 사유를 입력해야 마감할 수 있습니다.",
    });
    expect(await closeInboundDocumentAction(first.documentId, "공급처 결품 통보")).toEqual({ success: true, data: { incompleteLines: 1 } });
    expect(await docStatus(first.documentId)).toBe("CLOSED");

    // 마감 뒤 늦게 도착 → 다시 열기 → 스캔하면 안 왔던 줄에 이어지고 카드가 "전부 도착"으로
    expect(await reopenInboundDocumentAction(first.documentId)).toEqual({ success: true });
    expect(await docStatus(first.documentId)).toBe("PENDING");

    const late = await scan(t3, 7);

    expect(late.productId).toBe(product.id);
    expect(await stockOf(product.id)).toBeCloseTo(25);
    expect(await cardStep(first.documentId, true)).toBe("close");
    expect(await closeInboundDocumentAction(first.documentId, null)).toEqual({ success: true, data: { incompleteLines: 0 } });
  });

  it("잘못 찍은 박스를 취소하면 그 줄은 다시 '안 온' 것으로 돌아가 카드가 되돌아간다", async () => {
    const product = await newProduct();
    const trace = world.newTraceNo();
    const doc = await world.createDocumentLine({ traceNo: trace, product, quantity: 1 });
    const data = await scan(trace, 6);

    expect(await cardStep(doc.documentId, false)).toBe("close");
    expect((await voidScanAction(data.scanId)).success).toBe(true);
    expect(await stockOf(product.id)).toBe(0);
    expect(await cardStep(doc.documentId, false)).toBe("scan");
  });
});

describe("SC-3 상품 중복 제어 — 스캔 자동 생성 → 손 등록 차단 → 수정으로 겹치기 차단 → DB가 마지막으로 막음", () => {
  const part = () => `채끝-${world.runId}`;

  function productForm(fields: Record<string, string>): FormData {
    const data = new FormData();
    const defaults: Record<string, string> = { name: "", category: "가공육", subcategory: "", origin: "국내산", base_price: "5000", stock_quantity: "0" };

    for (const [key, value] of Object.entries({ ...defaults, ...fields })) data.set(key, value);

    return data;
  }

  it("같은 소 부위·등급의 박스를 여러 번 찍어도 상품은 하나이고, 다른 경로로는 같은 상품을 못 만든다", async () => {
    const p = part();
    const traces = [world.newTraceNo(), world.newTraceNo(), world.newTraceNo()];
    const productIds = new Set<string>();

    for (const traceNo of traces) {
      await world.seedTrace(traceNo, { part: p, grade: "1+" });
      const result = await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN" });

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
    expect(same![0].name).toBe(`${p} 1+`);
    expect(await stockOf([...productIds][0])).toBeCloseTo(12);

    // (a) 상품 관리 화면에서 같은 소 상품을 손으로 등록 → 소는 손 등록 자체가 막혀 있다
    const manual = await createProductAction(productForm({ category: "소", subcategory: p, grade: "1+", name: "" }));

    expect(manual.success).toBe(false);
    expect(manual.error).toContain("입고 스캔으로 자동 등록됩니다");

    // (b) 돼지·닭/오리도 마찬가지, 이력번호가 없는 가공육·양은 손으로 등록된다
    expect((await createProductAction(productForm({ category: "돼지", subcategory: "삼겹살", name: "손 삼겹" }))).success).toBe(false);
    expect((await createProductAction(productForm({ category: "닭/오리", subcategory: "통닭", name: "손 통닭" }))).success).toBe(false);
    expect((await createProductAction(productForm({ category: "가공육", subcategory: "소시지", name: "손 소시지" }))).success).toBe(true);
    expect((await createProductAction(productForm({ category: "양", subcategory: "", name: "양 다리" }))).success).toBe(true);

    // (c) 부위·등급이 비어 자동 생성된 상품을 수정으로 채우다가 이미 있는 키와 같아지면 거부
    const blank = await world.createProduct({ category: "소", subcategory: null, grade: null, origin: "국내산", name: "(부위 미지정)" });
    const clash = await updateProductAction(blank.id, productForm({ category: "소", subcategory: p, grade: "1+", origin: "국내산" }));

    expect(clash.success).toBe(false);
    expect(clash.error).toContain("이미 같은 상품이 등록되어 있습니다");

    // (d) 앱 검사를 우회해 DB에 직접 넣어도 유니크 인덱스가 막는다
    const raw = await adminClient().from("products").insert({
      wholesaler_id: world.wholesalerA,
      name: "직접 삽입",
      category: "소",
      subcategory: p,
      grade: "1+",
      origin: "국내산",
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
