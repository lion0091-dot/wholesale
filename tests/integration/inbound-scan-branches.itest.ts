/**
 * 입고 스캔 분기 테스트 — 현장이 박스를 찍는 한 번의 동작에서 갈라지는 지점(입력 경계·중복·동시·전표 상호작용·취소·분할)을
 * 사람이 손대지 않아도 끝까지 이어지는지 본다. 이력조회/상품 결정/전표 대조의 세부는 inbound·scenarios·sample-documents가 이미 한다.
 * 케이스 목록은 docs/inbound-scenario-tests.md "입고 스캔 분기" 절.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";
import { recordScanAction, recordSplitScansAction, voidScanAction, type ScanResult } from "@/app/dashboard/inbound/actions";
import { closeInboundDocumentAction, setDocumentsScanFinishedAction } from "@/app/dashboard/inbound/document-actions";

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

async function scansOf(traceNo: string) {
  const { data } = await adminClient()
    .from("inbound_scans")
    .select("id, status, weight, remaining_weight, labeled_weight")
    .eq("wholesaler_id", world.wholesalerA)
    .eq("trace_no", traceNo)
    .order("created_at", { ascending: true });

  return (data ?? []) as Array<{ id: string; status: string; weight: number; remaining_weight: number; labeled_weight: number | null }>;
}

async function ledgerSum(productId: string): Promise<number> {
  const { data } = await adminClient().from("stock_ledger").select("qty_delta").eq("product_id", productId);

  return ((data ?? []) as Array<{ qty_delta: number }>).reduce((sum, row) => sum + Number(row.qty_delta), 0);
}

async function docRow(documentId: string) {
  const { data } = await adminClient().from("inbound_documents").select("status, scan_finished_at").eq("id", documentId).single();

  return data as { status: string; scan_finished_at: string | null };
}

async function scan(traceNo: string, weight: number, extra: Partial<Parameters<typeof recordScanAction>[0]> = {}) {
  await world.seedTrace(traceNo, { part: "등심" });

  const result = await recordScanAction({ traceNo, weight, scanType: "BARCODE_SCAN", ...extra });

  expect(result.success, result.error).toBe(true);

  return result.data as ScanResult;
}

describe("입력 경계 — 이상한 값이 와도 친절한 안내로 끝나고 아무것도 반쯤 기록되지 않는다", () => {
  it("바코드에서 읽힌 표기중량이 0이면 그 값은 무시하고 입고된다(DB 제약 오류가 사용자에게 새지 않는다)", async () => {
    const product = await newProduct();
    const trace = world.newTraceNo();

    await world.createDocumentLine({ traceNo: trace, product });

    const data = await scan(trace, 8, { labeledWeight: 0 });

    expect(data.status).toBe("NORMAL");
    expect(data.labeledWeight).toBeNull();
    expect(await stockOf(product.id)).toBeCloseTo(8);
  });

  it("실중량이 저장 한도를 넘으면(단위 착오) 안내 문구로 거부하고 박스도 재고도 안 생긴다", async () => {
    const product = await newProduct();
    const trace = world.newTraceNo();

    await world.createDocumentLine({ traceNo: trace, product });
    await world.seedTrace(trace, { part: "등심" });

    const result = await recordScanAction({ traceNo: trace, weight: 100_000_000, scanType: "BARCODE_SCAN" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("중량");
    expect(result.error).not.toMatch(/numeric|overflow|constraint/i);
    expect(await scansOf(trace)).toHaveLength(0);
    expect(await stockOf(product.id)).toBe(0);
  });

  it("소수 넷째 자리 이하가 붙은 실중량은 저울 단위(0.001)로 맞춰 박스·원장·재고가 같고, 취소하면 정확히 0으로 돌아온다", async () => {
    const product = await newProduct();
    const trace = world.newTraceNo();

    await world.createDocumentLine({ traceNo: trace, product });

    const data = await scan(trace, 12.3456);
    const [box] = await scansOf(trace);

    expect(Number(box.weight)).toBeCloseTo(12.346, 3);
    expect(await ledgerSum(product.id)).toBeCloseTo(Number(box.weight), 3);
    expect(await stockOf(product.id)).toBeCloseTo(Number(box.weight), 3);
    expect((await voidScanAction(data.scanId)).success).toBe(true);
    expect(await ledgerSum(product.id)).toBeCloseTo(0, 6);
    expect(await stockOf(product.id)).toBeCloseTo(0, 6);
  });

  it("소문자로 온 묶음번호(l+14자리)도 대문자로 저장되어 전표 줄과 이어진다", async () => {
    const product = await newProduct();
    const lot = `L${String(Date.now()).padStart(14, "0").slice(-14)}`;

    await world.createDocumentLine({ traceNo: lot, product });
    await world.seedTrace(lot, { part: "등심", traceKind: "group" });

    const result = await recordScanAction({ traceNo: lot.toLowerCase(), weight: 20, scanType: "BARCODE_SCAN" });

    expect(result.success, result.error).toBe(true);
    expect((result.data as ScanResult).traceNo).toBe(lot);
    expect((result.data as ScanResult).productId).toBe(product.id);
  });
});

describe("중복·동시 — 같은 박스를 두 번 찍어도 재고가 두 배가 되지 않는다", () => {
  it("같은 번호·같은 무게를 동시에 5번 보내도(스캐너 이중 발사) 박스는 하나만 생기고 나머지는 중복 확인이 뜬다", async () => {
    const product = await newProduct();
    const trace = world.newTraceNo();

    await world.createDocumentLine({ traceNo: trace, product, quantity: 1 });
    await world.seedTrace(trace, { part: "등심" });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => recordScanAction({ traceNo: trace, weight: 7, scanType: "BARCODE_SCAN" }))
    );

    expect(results.every((result) => result.success)).toBe(true);
    expect((await scansOf(trace)).filter((row) => row.status !== "VOIDED")).toHaveLength(1);
    expect(results.filter((result) => result.data && "duplicate" in result.data)).toHaveLength(4);
    expect(await stockOf(product.id)).toBeCloseTo(7);
  });

  it("잘못 찍어 취소한 박스를 같은 번호·같은 무게로 다시 찍으면 중복을 묻지 않고 바로 들어간다", async () => {
    const product = await newProduct();
    const trace = world.newTraceNo();

    await world.createDocumentLine({ traceNo: trace, product });

    const first = await scan(trace, 9);

    expect((await voidScanAction(first.scanId)).success).toBe(true);

    const again = await scan(trace, 9);

    expect(again.status).toBe("NORMAL");
    expect(await stockOf(product.id)).toBeCloseTo(9);
  });

  it("같은 번호라도 무게가 다르면(한 마리를 여러 박스로 나눈 경우) 중복으로 보지 않는다", async () => {
    const trace = world.newTraceNo();

    await scan(trace, 6);
    await scan(trace, 4.5);

    expect((await scansOf(trace)).filter((row) => row.status !== "VOIDED")).toHaveLength(2);
  });
});

describe("스캔 종료·마감 — 현장이 다시 찍거나 취소해도 사람이 '다시 시작'·'다시 열기'를 누를 필요가 없다", () => {
  async function threeLineDocument() {
    const product = await newProduct();
    const [t1, t2, t3] = [world.newTraceNo(), world.newTraceNo(), world.newTraceNo()];
    const first = await world.createDocumentLine({ traceNo: t1, product, quantity: 1 });

    await world.createDocumentLine({ traceNo: t2, product, quantity: 1, documentId: first.documentId });
    await world.createDocumentLine({ traceNo: t3, product, quantity: 1, documentId: first.documentId });

    return { product, t1, t2, t3, documentId: first.documentId };
  }

  it("스캔 종료를 눌렀어도 그 전표의 박스를 더 찍으면 종료 표시가 저절로 풀려 사무실이 '아직 찍는 중'으로 본다", async () => {
    const { t1, t2, documentId } = await threeLineDocument();

    await scan(t1, 5);
    expect(await setDocumentsScanFinishedAction([documentId], true)).toEqual({ success: true, data: { changed: 1 } });
    expect((await docRow(documentId)).scan_finished_at).not.toBeNull();

    await scan(t2, 5);

    const doc = await docRow(documentId);

    expect(doc.status).toBe("PENDING");
    expect(doc.scan_finished_at).toBeNull();
  });

  it("스캔 종료 뒤 찍은 박스가 어느 전표 줄과도 안 이어지면 종료 표시는 그대로다", async () => {
    const { t1, documentId } = await threeLineDocument();

    await scan(t1, 5);
    await setDocumentsScanFinishedAction([documentId], true);
    await scan(world.newTraceNo(), 5);

    expect((await docRow(documentId)).scan_finished_at).not.toBeNull();
  });

  it("저절로 마감된 전표의 박스를 취소하면 전표가 저절로 다시 열려 그 줄이 '안 온 것'으로 카드에 돌아온다", async () => {
    const product = await newProduct();
    const trace = world.newTraceNo();
    const { documentId } = await world.createDocumentLine({ traceNo: trace, product, quantity: 1 });
    const data = await scan(trace, 6);

    expect((await docRow(documentId)).status).toBe("CLOSED");
    expect((await voidScanAction(data.scanId)).success).toBe(true);
    expect(await stockOf(product.id)).toBe(0);
    expect((await docRow(documentId)).status).toBe("PENDING");

    // 같은 박스를 다시 찍으면 처음처럼 이어지고 저절로 마감된다.
    await scan(trace, 6);

    expect((await docRow(documentId)).status).toBe("CLOSED");
  });

  it("사무실이 미입고 사유를 적어 마감한 전표라도 이어졌던 박스를 취소하면 다시 열려 사무실이 알아챌 수 있다", async () => {
    const { t1, documentId } = await threeLineDocument();
    const data = await scan(t1, 5);

    await setDocumentsScanFinishedAction([documentId], true);

    expect((await closeInboundDocumentAction(documentId, "결품")).success).toBe(true);
    expect((await docRow(documentId)).status).toBe("CLOSED");
    expect((await voidScanAction(data.scanId)).success).toBe(true);
    expect((await docRow(documentId)).status).toBe("PENDING");
  });
});

describe("박스 나눠서 입고 — 중간에 실패하면 반쪽만 남지 않고 전부 되돌려진다", () => {
  it("모든 줄이 성공하면 줄마다 박스가 생기고 상품별 재고가 늘어난다", async () => {
    const [a, b] = [await newProduct({ subcategory: "등심" }), await newProduct({ subcategory: "안심" })];
    const box = world.newTraceNo();

    await world.seedTrace(box, { part: "등심" });

    const result = await recordSplitScansAction({
      boxCode: box,
      rows: [
        { productId: a.id, weight: 5, traceNo: "" },
        { productId: b.id, weight: 3, traceNo: "" },
      ],
    });

    expect(result.success, result.error).toBe(true);
    expect((await scansOf(box)).filter((row) => row.status === "NORMAL")).toHaveLength(2);
    expect(await stockOf(a.id)).toBeCloseTo(5);
    expect(await stockOf(b.id)).toBeCloseTo(3);
  });

  it("다른 업체 상품이 섞여 있으면 하나도 기록하지 않고 거부한다(앞 줄만 들어가는 일이 없다)", async () => {
    const mine = await newProduct({ subcategory: "등심" });
    const { data: foreign } = await adminClient()
      .from("products")
      .insert({ wholesaler_id: world.wholesalerB, name: `타업체-${world.runId}`, category: "소", subcategory: "안심", unit: "kg", price: 1000, stock_quantity: 0, is_active: true })
      .select("id")
      .single();
    const box = world.newTraceNo();

    await world.seedTrace(box, { part: "등심" });

    const result = await recordSplitScansAction({
      boxCode: box,
      rows: [
        { productId: mine.id, weight: 5, traceNo: "" },
        { productId: String(foreign?.id), weight: 3, traceNo: "" },
      ],
    });

    expect(result.success).toBe(false);
    expect(await scansOf(box)).toHaveLength(0);
    expect(await stockOf(mine.id)).toBe(0);
  });

  it("두 번째 줄의 번호 형식이 틀리면 기록 전에 거부해 첫 줄도 들어가지 않고 재고가 그대로다", async () => {
    const [a, b] = [await newProduct({ subcategory: "등심" }), await newProduct({ subcategory: "안심" })];
    const box = world.newTraceNo();

    await world.seedTrace(box, { part: "등심" });

    const result = await recordSplitScansAction({
      boxCode: box,
      rows: [
        { productId: a.id, weight: 5, traceNo: "" },
        { productId: b.id, weight: 3, traceNo: "형식틀림" },
      ],
    });

    expect(result.success).toBe(false);
    expect((await scansOf(box)).filter((row) => row.status !== "VOIDED")).toHaveLength(0);
    expect(await stockOf(a.id)).toBeCloseTo(0, 6);
    expect(await stockOf(b.id)).toBe(0);
  });
});
