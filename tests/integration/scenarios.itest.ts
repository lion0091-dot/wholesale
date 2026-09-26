/**
 * 시나리오 테스트 — 2026-09-25 입고 자동화(전표 대조·지금 할 일 카드·스캔 종료)부터 상품 중복 제어(소 유니크·손 등록 차단)까지
 * 사용자가 실제로 밟는 순서대로 여러 기능을 이어 붙여 본다. 기능별 세부 케이스는 inbound/documents/products/outbound.itest.ts가 이미 한다.
 * 시나리오 목록·기대 결과는 docs/inbound-scenario-tests.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World, type WorldProduct } from "./harness";
import { recordScanAction, voidScanAction, type ScanResult } from "@/app/dashboard/inbound/actions";
import {
  closeInboundDocumentAction,
  discardInboundDocumentAction,
  linkScanToDocumentLineAction,
  extractDocumentTableAction,
  reopenInboundDocumentAction,
  restoreInboundDocumentAction,
  saveInboundDocumentAction,
  setDocumentLineCountModeAction,
  setDocumentsScanFinishedAction,
  updateDocumentLineAction,
} from "@/app/dashboard/inbound/document-actions";
import { decodeDocumentFileText } from "@/lib/livestock/document-file-text";
import { applyColumnMap, parseDocumentText } from "@/lib/livestock/document-parser";
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

describe("SC-1 정상 하루 — 전표 올리기 → 현장 스캔이 전표와 저절로 이어짐 → 전부 도착 → 카드에서 마감", () => {
  it("전표 2줄 → 박스 2개 → 재고는 스캔이 만들고, 마감은 재고를 안 바꾼다", async () => {
    const product = await newProduct();
    const traceA = world.newTraceNo();
    const traceB = world.newTraceNo();
    const first = await world.createDocumentLine({ traceNo: traceA, product, quantity: 1 });

    await world.createDocumentLine({ traceNo: traceB, product, quantity: 1, documentId: first.documentId });

    // 스캔 전: 카드는 "현장에서 스캔 중" 단계이고 전표를 올렸어도 재고는 0이다
    expect(await cardStep(first.documentId, false)).toBe("scan");
    expect(await stockOf(product.id)).toBe(0);

    // 현장: 상품을 고르지 않고 바코드만 찍는다 — 전표 줄이 상품을 정해 준다
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

    // 마지막 박스가 도착하는 순간 사람이 누르지 않아도 저절로 마감된다 — 재고는 그대로다
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
    // 덜 왔으면 자동 마감하지 않는다
    expect(await docStatus(first.documentId)).toBe("PENDING");

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
    // 늦게 온 박스로 모든 줄이 채워지면 다시 저절로 마감된다
    expect(await docStatus(first.documentId)).toBe("CLOSED");
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

describe("SC-5 이메일로 받은 전표를 폰 파일함에서 골라 올린다 — 파일 종류별 (CSV·CP949·PDF·사진·이상한 파일)", () => {
  /** 한글 완성형(KS X 1001) 영역만 만든 테스트용 CP949 인코더 — 한국 엑셀 "CSV(쉼표로 분리)"가 이 인코딩이다. */
  function eucKrEncode(text: string): Uint8Array {
    const decoder = new TextDecoder("euc-kr");
    const table = new Map<string, [number, number]>();

    for (let hi = 0xb0; hi <= 0xc8; hi += 1) {
      for (let lo = 0xa1; lo <= 0xfe; lo += 1) {
        const ch = decoder.decode(new Uint8Array([hi, lo]));

        if (ch.length === 1 && ch !== "�") table.set(ch, [hi, lo]);
      }
    }

    const bytes: number[] = [];

    for (const ch of text) {
      const pair = table.get(ch);

      if (pair) bytes.push(pair[0], pair[1]);
      else bytes.push(ch.charCodeAt(0));
    }

    return new Uint8Array(bytes);
  }

  async function pdfWithText(): Promise<Uint8Array> {
    const { createRequire } = await import("node:module");
    const path = await import("node:path");
    const PDFDocument = createRequire(import.meta.url)("pdfkit");
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    const cols = [40, 170, 300, 370, 450];
    const row = (y: number, cells: string[]) =>
      cells.forEach((cell, i) => cell && doc.fontSize(10).text(cell, cols[i], y, { lineBreak: false }));

    doc.registerFont("kr", path.join(process.cwd(), "assets/fonts/NotoSansKR-Regular.ttf"));
    doc.font("kr");
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));

    return new Promise((resolve) => {
      doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      row(90, ["품목", "이력번호", "중량", "단가", "금액"]);
      row(110, ["안심", "002123456781", "7.10", "90,000", "639,000"]);
      doc.end();
    });
  }

  function fileForm(bytes: Uint8Array | string, name: string, type: string): FormData {
    const form = new FormData();

    form.append("file", new File([bytes as BlobPart], name, { type }));

    return form;
  }

  it("CP949 CSV(한국 엑셀 기본 저장) → 글자 안 깨지고 저장 → 박스를 찍으면 부위 이름 그대로 상품이 만들어진다", async () => {
    const part1 = `안심`;
    const traceA = world.newTraceNo();
    const traceB = world.newTraceNo();
    const csv = ["품목,부위,이력번호,중량,단가,금액", `한우 ${part1},${part1},${traceA},7.1,90000,639000`, `한우 채끝,채끝,${traceB},9.8,70000,686000`].join("\r\n");

    // 폰 파일함에서 고른 파일의 바이트 → (브라우저) 글자로 → 표로 → 줄로
    const text = decodeDocumentFileText(eucKrEncode(csv));
    const grid = parseDocumentText(text);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.itemName)).toEqual(["한우 안심", "한우 채끝"]);
    expect(lines.map((line) => line.partName)).toEqual(["안심", "채끝"]);
    expect(text).not.toContain("�");

    const form = new FormData();

    form.append("payload", JSON.stringify({ supplierName: `파일함축산-${world.runId}`, lines: lines.map((line) => ({ ...line, productId: null })) }));
    form.append("file", new File([eucKrEncode(csv) as BlobPart], "전표.CSV", { type: "" }));

    const saved = await saveInboundDocumentAction(form);

    expect(saved.success).toBe(true);

    // 한글 파일명("전표.CSV")이어도 원본이 보관된다 — Storage 키는 ASCII만 받아 예전엔 InvalidKey로 실패했다
    const { data: savedDoc } = await adminClient().from("inbound_documents").select("file_name, storage_path").eq("id", (saved.data as { documentId: string }).documentId).single();

    expect(savedDoc?.file_name).toBe("전표.CSV");
    expect(savedDoc?.storage_path).toBeTruthy();
    expect(savedDoc?.storage_path).toMatch(/^[A-Za-z0-9\/._-]+$/);

    // 현장: 박스를 찍는다 — 상품은 전표 부위로 자동 생성된다
    await world.seedTrace(traceA, { part: null, grade: null });
    await world.seedTrace(traceB, { part: null, grade: null });

    const a = (await recordScanAction({ traceNo: traceA, weight: 7.1, scanType: "BARCODE_SCAN" })).data as ScanResult;
    const b = (await recordScanAction({ traceNo: traceB, weight: 9.8, scanType: "BARCODE_SCAN" })).data as ScanResult;
    const { data: products } = await adminClient().from("products").select("name, subcategory").in("id", [a.productId!, b.productId!]);

    expect((products ?? []).map((row) => row.subcategory).sort()).toEqual(["안심", "채끝"]);
    expect(JSON.stringify(products)).not.toContain("�");
  });

  it("텍스트 PDF(이메일 첨부) → 서버가 표를 되살린다 / 글자 없는 PDF·깨진 파일·큰 파일은 안내 문구로 거부되어 원본 보관으로 넘어간다", async () => {
    const pdf = await pdfWithText();
    const ok = await extractDocumentTableAction(fileForm(pdf, "거래명세서.pdf", "application/pdf"));

    expect(ok.success).toBe(true);
    expect(ok.data!.hasText).toBe(true);
    expect(JSON.stringify(ok.data!.cells)).toContain("002123456781");

    // 깨진 파일 — 예외로 죽지 않고 실패 결과(클라이언트는 원본만 보관으로 처리)
    const broken = await extractDocumentTableAction(fileForm("이건 PDF가 아닙니다", "가짜.pdf", "application/pdf"));

    expect(broken.success).toBe(false);

    // 8MB 초과
    const huge = await extractDocumentTableAction(fileForm(new Uint8Array(8 * 1024 * 1024 + 1), "큰파일.pdf", "application/pdf"));

    expect(huge).toEqual({ success: false, error: "파일이 너무 큽니다. 8MB 이하로 올려주세요." });

    // 파일이 없음
    expect((await extractDocumentTableAction(new FormData())).success).toBe(false);
  });

  it("직원 계정으로도 파일을 올려 읽을 수 있고, 고객·비로그인은 안 된다", async () => {
    const pdf = await pdfWithText();

    await actAs(world.users.staffA);
    expect((await extractDocumentTableAction(fileForm(pdf, "a.pdf", "application/pdf"))).success).toBe(true);

    await actAs(world.users.retailerR);
    expect((await extractDocumentTableAction(fileForm(pdf, "a.pdf", "application/pdf"))).success).toBe(false);

    await actAs(null);
    expect((await extractDocumentTableAction(fileForm(pdf, "a.pdf", "application/pdf"))).success).toBe(false);
  });

  it("사진·스캔본은 품목 줄 없이 원본만 저장된다(글자를 못 읽는 서류 — 손으로 받아적지 않는다)", async () => {
    const form = new FormData();

    form.append("payload", JSON.stringify({ supplierName: `사진축산-${world.runId}`, lines: [] }));
    form.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], "거래명세서 사진 (1).JPG", { type: "image/jpeg" }));

    const saved = await saveInboundDocumentAction(form);

    expect(saved.success).toBe(true);

    const { data: doc } = await adminClient().from("inbound_documents").select("id, storage_path, status").eq("id", (saved.data as { documentId: string }).documentId).single();
    const { count } = await adminClient().from("inbound_document_lines").select("id", { count: "exact", head: true }).eq("document_id", doc!.id);

    expect(doc!.storage_path).toBeTruthy();
    expect(count).toBe(0);
  });
});

async function linkedLineIds(scanId: string): Promise<string[]> {
  const { data } = await adminClient().from("inbound_document_line_scans").select("line_id").eq("scan_id", scanId);

  return ((data ?? []) as Array<{ line_id: string }>).map((row) => row.line_id);
}

async function scanPart(traceNo: string, part: string, weight: number) {
  await world.seedTrace(traceNo, { part });

  const result = await recordScanAction({ traceNo, weight, scanType: "BARCODE_SCAN" });

  expect(result.success).toBe(true);

  return result.data as ScanResult;
}

describe("SC-부위 — 이력번호가 없거나 여러 줄에 걸친 전표를 부위로 마저 이음", () => {
  it("번호 없는 줄: 무게·축종·부위가 맞는 줄이 하나면 자동으로 이어진다", async () => {
    const sirloin = await world.createDocumentLine({ traceNo: null, itemName: "한우 등심", partName: "등심", labeledWeight: 10 });
    const tenderloin = await world.createDocumentLine({ traceNo: null, itemName: "한우 안심", partName: "안심", labeledWeight: 10, documentId: sirloin.documentId });

    const result = await scanPart(world.newTraceNo(), "등심", 10.1);

    expect(await linkedLineIds(result.scanId)).toEqual([sirloin.lineId]);
    expect(await linkedLineIds(result.scanId)).not.toContain(tenderloin.lineId);
  });

  it("번호 없는 줄: 같은 부위 줄이 둘이면 자동으로 잇지 않고 사무실에 남긴다", async () => {
    const first = await world.createDocumentLine({ traceNo: null, itemName: "한우 채끝", partName: "채끝", labeledWeight: 10 });

    await world.createDocumentLine({ traceNo: null, itemName: "한우 채끝", partName: "채끝", labeledWeight: 10, documentId: first.documentId });

    const result = await scanPart(world.newTraceNo(), "채끝", 10);

    expect(await linkedLineIds(result.scanId)).toEqual([]);
  });

  it("번호 없는 줄: 부위가 안 맞으면 무게가 맞아도 자동으로 잇지 않는다", async () => {
    await world.createDocumentLine({ traceNo: null, itemName: "한우 양지", partName: "양지", labeledWeight: 20 });

    const result = await scanPart(world.newTraceNo(), "우둔", 20);

    expect(await linkedLineIds(result.scanId)).toEqual([]);
  });

  it("번호 없는 줄: 무게가 ±10%를 벗어나면 잇지 않는다", async () => {
    await world.createDocumentLine({ traceNo: null, itemName: "한우 사태", partName: "사태", labeledWeight: 10 });

    const result = await scanPart(world.newTraceNo(), "사태", 12);

    expect(await linkedLineIds(result.scanId)).toEqual([]);
  });

  it("번호 없는 줄에 이미 자리가 다 찼으면 더 잇지 않는다", async () => {
    const line = await world.createDocumentLine({ traceNo: null, itemName: "한우 앞다리", partName: "앞다리", labeledWeight: 10, quantity: 1 });
    const first = await scanPart(world.newTraceNo(), "앞다리", 10);
    const second = await scanPart(world.newTraceNo(), "앞다리", 10);

    expect(await linkedLineIds(first.scanId)).toEqual([line.lineId]);
    expect(await linkedLineIds(second.scanId)).toEqual([]);
  });

  it("한 마리를 쪼갠 전표(같은 번호가 두 줄): 박스 부위가 적힌 줄로 이어진다", async () => {
    const traceNo = world.newTraceNo();
    const sirloin = await world.createDocumentLine({ traceNo, itemName: "한우 등심", partName: "등심", quantity: 1 });
    const tenderloin = await world.createDocumentLine({ traceNo, itemName: "한우 안심", partName: "안심", quantity: 1, documentId: sirloin.documentId });

    const result = await scanPart(traceNo, "안심", 5);

    expect(await linkedLineIds(result.scanId)).toEqual([tenderloin.lineId]);
  });

  it("한 마리를 쪼갠 전표: 박스 부위가 어느 줄에도 없으면 잇지 않는다", async () => {
    const traceNo = world.newTraceNo();
    const sirloin = await world.createDocumentLine({ traceNo, itemName: "한우 등심", partName: "등심", quantity: 1 });

    await world.createDocumentLine({ traceNo, itemName: "한우 안심", partName: "안심", quantity: 1, documentId: sirloin.documentId });

    const result = await scanPart(traceNo, "양지", 5);

    expect(await linkedLineIds(result.scanId)).toEqual([]);
  });
});

describe("SC-기준 — 줄마다 박스 수/무게로 세서 한 전표가 저절로 끝난다", () => {
  function newLotNo(): string {
    const lot = `L${String(Math.floor(Math.random() * 1e14)).padStart(14, "0")}`;

    return lot;
  }

  it("개체번호 10kg 줄 + 로트번호 3박스 줄이 한 전표에 있어도, 각각의 기준으로 다 오면 저절로 마감된다", async () => {
    const individual = world.newTraceNo();
    const lot = newLotNo();
    const first = await world.createDocumentLine({ traceNo: individual, itemName: "한우 등심", partName: "등심", labeledWeight: 10 });

    await world.createDocumentLine({ traceNo: lot, itemName: "한우 갈비", partName: "갈비", quantity: 3, labeledWeight: 30, documentId: first.documentId });

    // 개체번호는 한 마리가 세 박스로 나뉘어 와도(무게 합 9.9kg ≈ 10kg) 다 온 것.
    await scanPart(individual, "등심", 3.4);
    await scanPart(individual, "등심", 3.3);
    expect(await docStatus(first.documentId)).toBe("PENDING");
    await scanPart(individual, "등심", 3.2);
    expect(await docStatus(first.documentId)).toBe("PENDING");

    // 로트번호는 박스 3개가 다 와야 한다(무게가 같아도 같은 번호가 연달아 찍히는 게 정상).
    await scanPart(lot, "갈비", 10);
    await scanPart(lot, "갈비", 10);
    expect(await docStatus(first.documentId)).toBe("PENDING");
    await scanPart(lot, "갈비", 10);
    expect(await docStatus(first.documentId)).toBe("CLOSED");
  });

  it("개체번호 줄은 박스 수가 아니라 무게가 모자라면 마감되지 않는다", async () => {
    const individual = world.newTraceNo();
    const line = await world.createDocumentLine({ traceNo: individual, itemName: "한우 안심", partName: "안심", labeledWeight: 10 });

    await scanPart(individual, "안심", 6);
    expect(await docStatus(line.documentId)).toBe("PENDING");
  });

  it("사무실이 줄 기준을 박스 수로 바꾸면 그 순간 다 찬 전표는 저절로 마감된다", async () => {
    const individual = world.newTraceNo();
    const line = await world.createDocumentLine({ traceNo: individual, itemName: "한우 우둔", partName: "우둔", labeledWeight: 10 });

    await scanPart(individual, "우둔", 6);
    expect(await docStatus(line.documentId)).toBe("PENDING");

    const changed = await setDocumentLineCountModeAction(line.lineId, "BOXES");

    expect(changed).toMatchObject({ success: true, data: { effectiveMode: "BOXES" } });
    expect(await docStatus(line.documentId)).toBe("CLOSED");
  });

  it("무게로 세는 줄이 모자란 채 스캔 종료되면 카드는 '무게가 덜 찬 줄'로 안내한다", () => {
    const step = pickInboundNextStep({
      pendingDocuments: [{ id: "d", scanFinished: false, completeLines: 0, totalLines: 1 }],
      remainingBoxCount: 1,
      remainingWeightLines: 1,
      needsCheckScanCount: 0,
    });

    expect(step.key).toBe("scan");
    expect(step.detail).toContain("무게가 덜 찬 줄 1줄");
    expect(step.detail).not.toContain("박스 1개");
  });
});

describe("SC-나중에 — 박스를 먼저 찍고 전표를 나중에 올려도 저절로 이어지고 마감된다", () => {
  async function saveDocument(lines: Array<Record<string, unknown>>): Promise<string> {
    const form = new FormData();

    form.append("payload", JSON.stringify({ supplierName: `나중전표-${world.runId}`, lines: lines.map((line, index) => ({ lineNo: index + 1, ...line })) }));

    const saved = await saveInboundDocumentAction(form);

    expect(saved.success).toBe(true);

    return (saved.data as { documentId: string }).documentId;
  }

  async function linkedScanIdsOf(documentId: string): Promise<string[]> {
    const { data: lines } = await adminClient().from("inbound_document_lines").select("id").eq("document_id", documentId);
    const { data: links } = await adminClient()
      .from("inbound_document_line_scans")
      .select("scan_id")
      .in("line_id", ((lines ?? []) as Array<{ id: string }>).map((line) => line.id));

    return ((links ?? []) as Array<{ scan_id: string }>).map((link) => link.scan_id);
  }

  it("번호가 있는 줄(내 상품 칸 비움): 먼저 찍힌 박스가 전표를 저장하는 순간 이어지고 다 찼으면 마감된다", async () => {
    const traceNo = world.newTraceNo();
    const box = await scanPart(traceNo, "등심", 5);

    expect(await linkedLineIds(box.scanId)).toEqual([]);

    const documentId = await saveDocument([{ itemName: "한우 등심", traceNo, partName: "등심", quantity: 1 }]);

    expect(await linkedScanIdsOf(documentId)).toEqual([box.scanId]);
    expect(await docStatus(documentId)).toBe("CLOSED");
  });

  it("번호 없는 줄: 먼저 찍힌 박스가 무게·부위로 이어진다", async () => {
    const box = await scanPart(world.newTraceNo(), "부채살", 12.1);
    const documentId = await saveDocument([{ itemName: "한우 부채살", partName: "부채살", labeledWeight: 12 }]);

    expect(await linkedScanIdsOf(documentId)).toEqual([box.scanId]);
    expect(await docStatus(documentId)).toBe("CLOSED");
  });

  it("개체번호 10kg 줄: 먼저 찍힌 세 박스가 모두 이어지고 무게 합이 맞으면 마감된다", async () => {
    const traceNo = world.newTraceNo();
    const a = await scanPart(traceNo, "설도", 3.4);
    const b = await scanPart(traceNo, "설도", 3.3);
    const c = await scanPart(traceNo, "설도", 3.2);
    const documentId = await saveDocument([{ itemName: "한우 설도", traceNo, partName: "설도", labeledWeight: 10 }]);

    expect((await linkedScanIdsOf(documentId)).sort()).toEqual([a.scanId, b.scanId, c.scanId].sort());
    expect(await docStatus(documentId)).toBe("CLOSED");
  });

  it("부위가 안 맞는 박스는 무게가 같아도 이어지지 않는다", async () => {
    const box = await scanPart(world.newTraceNo(), "홍두깨", 8);
    const documentId = await saveDocument([{ itemName: "한우 도가니", partName: "도가니", labeledWeight: 8 }]);

    expect(await linkedScanIdsOf(documentId)).not.toContain(box.scanId);
    expect(await docStatus(documentId)).toBe("PENDING");
  });
});

describe("SC-정정 — 전표 내용이 틀려 취소 처리하고 다시 올려도 박스가 새 전표에 이어진다", () => {
  async function saveDoc(lines: Array<Record<string, unknown>>, documentNo?: string): Promise<string> {
    const form = new FormData();

    form.append("payload", JSON.stringify({ supplierName: `정정전표-${world.runId}`, documentNo: documentNo ?? null, lines: lines.map((line, index) => ({ lineNo: index + 1, ...line })) }));

    const saved = await saveInboundDocumentAction(form);

    expect(saved.success).toBe(true);

    return (saved.data as { documentId: string }).documentId;
  }

  async function linkedScanIdsOfDoc(documentId: string): Promise<string[]> {
    const { data: lines } = await adminClient().from("inbound_document_lines").select("id").eq("document_id", documentId);
    const { data: links } = await adminClient()
      .from("inbound_document_line_scans")
      .select("scan_id")
      .in("line_id", ((lines ?? []) as Array<{ id: string }>).map((line) => line.id));

    return ((links ?? []) as Array<{ scan_id: string }>).map((link) => link.scan_id);
  }

  it("잘못 올린 전표를 취소 처리하면 박스가 풀리고, 다시 올린 전표에 저절로 이어져 마감된다", async () => {
    const traceNo = world.newTraceNo();
    const first = await saveDoc([{ itemName: "한우 등심", traceNo, partName: "등심", quantity: 5 }], `정정-${world.runId}`);
    const box = await scanPart(traceNo, "등심", 5);

    expect(await linkedScanIdsOfDoc(first)).toEqual([box.scanId]);
    expect(await docStatus(first)).toBe("PENDING");

    // 수량을 5로 잘못 적었다 — 줄은 못 고치니 취소 처리 후 다시 올린다.
    const discarded = await discardInboundDocumentAction(first);

    expect(discarded.success).toBe(true);
    expect(await linkedScanIdsOfDoc(first)).toEqual([]);

    const second = await saveDoc([{ itemName: "한우 등심", traceNo, partName: "등심", quantity: 1 }], `정정-${world.runId}`);

    expect(await linkedScanIdsOfDoc(second)).toEqual([box.scanId]);
    expect(await docStatus(second)).toBe("CLOSED");
  });

  it("취소 처리했던 전표를 되살리면 박스가 다시 이어진다", async () => {
    const traceNo = world.newTraceNo();
    const documentId = await saveDoc([{ itemName: "한우 안심", traceNo, partName: "안심", quantity: 1 }]);
    const box = await scanPart(traceNo, "안심", 4);

    expect(await docStatus(documentId)).toBe("CLOSED");

    await discardInboundDocumentAction(documentId);
    expect(await linkedScanIdsOfDoc(documentId)).toEqual([]);

    const restored = await restoreInboundDocumentAction(documentId);

    expect(restored.success).toBe(true);
    expect(await linkedScanIdsOfDoc(documentId)).toEqual([box.scanId]);
  });
});

describe("SC-더 많이 옴 — 표기 무게·수량이 없는 개체번호 줄에 여러 박스가 오면 알려 주고 사유를 적어야 마감된다", () => {
  async function threeBoxesOfOneAnimal(part: string) {
    const individual = world.newTraceNo();
    const line = await world.createDocumentLine({ traceNo: individual, itemName: `한우 ${part}`, partName: part });
    const first = await scanPart(individual, part, 3);
    const second = await scanPart(individual, part, 3.1);
    const third = await scanPart(individual, part, 4);

    return { line, first, second, third };
  }

  it("첫 박스에서 전표가 마감되고, 뒤에 온 박스는 '이미 마감된 전표에 있는 번호'라고 알려 준다", async () => {
    const { line, first, second, third } = await threeBoxesOfOneAnimal("목심");

    expect(first.autoClosedDocument).toBe(true);
    expect(await docStatus(line.documentId)).toBe("CLOSED");
    expect(second.matchedClosedDocument).toBe(true);
    expect(third.matchedClosedDocument).toBe(true);
    expect(await linkedLineIds(second.scanId)).toEqual([]);
  });

  it("뒤에 온 박스는 사무실 조회(종 배지·카드)에도 잡히고, 다시 열어 이으면 사라지며, 다른 업체에는 안 보인다", async () => {
    const { line, second, third } = await threeBoxesOfOneAnimal("갈비");
    const listLate = async () => {
      const { data } = await getActorClient().rpc("list_unlinked_boxes_for_documents", { p_wholesaler_id: world.wholesalerA });

      return ((data ?? []) as Array<{ scan_id: string; document_id: string; document_status: string }>).filter((row) => row.document_status === "CLOSED");
    };

    const late = await listLate();

    expect(late.filter((row) => row.document_id === line.documentId).map((row) => row.scan_id).sort()).toEqual(
      [second.scanId, third.scanId].sort()
    );

    await reopenInboundDocumentAction(line.documentId);
    await linkScanToDocumentLineAction(second.scanId, line.lineId);
    await linkScanToDocumentLineAction(third.scanId, line.lineId);

    expect((await listLate()).filter((row) => row.document_id === line.documentId)).toEqual([]);

    await actAs(world.users.ownerB);
    const stranger = await getActorClient().rpc("list_unlinked_boxes_for_documents", { p_wholesaler_id: world.wholesalerA });

    expect(stranger.data ?? []).toEqual([]);
  });

  it("다시 열어 뒤 박스를 이으면 '더 많이 옴'이 되어 사유 없이는 마감되지 않고, 사유를 적으면 마감된다", async () => {
    const { line, second, third } = await threeBoxesOfOneAnimal("설도");

    expect((await reopenInboundDocumentAction(line.documentId)).success).toBe(true);
    expect((await linkScanToDocumentLineAction(second.scanId, line.lineId)).success).toBe(true);
    expect((await linkScanToDocumentLineAction(third.scanId, line.lineId)).success).toBe(true);

    const noReason = await closeInboundDocumentAction(line.documentId, null);

    expect(noReason.success).toBe(false);
    expect(noReason.error).toContain("사유");

    const withReason = await closeInboundDocumentAction(line.documentId, "한 마리가 세 박스로 옴");

    expect(withReason.success).toBe(true);
    expect(await docStatus(line.documentId)).toBe("CLOSED");
  });

  it("줄에 표기 무게를 넣으면 무게 기준으로 바뀌어 사유 없이도 마감할 수 있다(줄 내용 고치기)", async () => {
    const { line, second, third } = await threeBoxesOfOneAnimal("우둔");

    await reopenInboundDocumentAction(line.documentId);
    await linkScanToDocumentLineAction(second.scanId, line.lineId);
    await linkScanToDocumentLineAction(third.scanId, line.lineId);

    expect((await closeInboundDocumentAction(line.documentId, null)).success).toBe(false);

    const edited = await updateDocumentLineAction(line.lineId, { labeledWeight: 10 }, "표기 무게 추가");

    expect(edited.success).toBe(true);
    expect((await closeInboundDocumentAction(line.documentId, null)).success).toBe(true);
  });
});
