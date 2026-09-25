/**
 * 29단계 B — 사무실 대조 화면(app/dashboard/inbound/documents/[id]) 서버 액션 4개.
 * DB 함수(link/unlink/close/reopen, 마이그레이션 118) 자체의 동작(자동 배정·중복 창 우회·
 * 취소 시 해제·거슬러 배정)은 tests/integration/inbound.itest.ts의
 * "명세서 줄 ↔ 박스 연결" 절이 이미 검증한다. 여기서는 서버 액션 한 겹(권한 매핑·오류 문구)만 본다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World, type WorldProduct } from "./harness";
import {
  closeInboundDocumentAction,
  linkScanToDocumentLineAction,
  reopenInboundDocumentAction,
  unlinkScanFromDocumentLineAction,
} from "@/app/dashboard/inbound/document-actions";
import { documentLineExpectedQty, documentLineMatchStatus } from "@/lib/livestock/document-reconciliation";

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
  return world.createProduct({ stock_quantity: 0, subcategory: "등심", category: "소", ...overrides });
}

/** 링크 테스트는 record_inbound_scan_base(정부 API 흐름)를 거칠 필요가 없어 박스 행을 직접 시드한다. */
async function seedScan(overrides: Record<string, unknown> = {}) {
  const { trace_no: traceNoOverride, ...rest } = overrides;
  const traceNo = (traceNoOverride as string | undefined) ?? world.newTraceNo();
  const { data, error } = await adminClient()
    .from("inbound_scans")
    .insert({
      wholesaler_id: world.wholesalerA,
      trace_no: traceNo,
      product_id: null,
      weight: 5,
      scan_type: "MANUAL",
      status: "NORMAL",
      remaining_weight: 0,
      ...rest,
    })
    .select("id, trace_no")
    .single();

  if (error || !data) {
    throw new Error(`시드 실패 — inbound_scans: ${error?.message}`);
  }

  return { scanId: String(data.id), traceNo: String(data.trace_no) };
}

async function linkRow(scanId: string) {
  const { data } = await adminClient()
    .from("inbound_document_line_scans")
    .select("line_id, linked_how")
    .eq("scan_id", scanId)
    .maybeSingle();

  return data;
}

describe("linkScanToDocumentLineAction / unlinkScanFromDocumentLineAction", () => {
  it("정상 — 수동으로 붙이고 뗄 수 있다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, product });
    const scan = await seedScan({ trace_no: world.newTraceNo() });

    const linked = await linkScanToDocumentLineAction(scan.scanId, lineId);

    expect(linked).toMatchObject({ success: true, data: { expected: 1, linked: 1, status: "COMPLETE" } });
    expect(await linkRow(scan.scanId)).toMatchObject({ line_id: lineId, linked_how: "MANUAL" });

    const unlinked = await unlinkScanFromDocumentLineAction(scan.scanId);

    expect(unlinked).toEqual({ success: true });
    expect(await linkRow(scan.scanId)).toBeNull();
  });

  it("타 업체 문서 줄에는 붙일 수 없다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, product });
    const scan = await seedScan({ trace_no: world.newTraceNo() });

    await actAs(world.users.ownerB);

    const result = await linkScanToDocumentLineAction(scan.scanId, lineId);

    expect(result).toEqual({ success: false, error: "이 명세서에 접근할 권한이 없습니다." });
    expect(await linkRow(scan.scanId)).toBeNull();
  });

  it("마감된 명세서에는 붙이거나 뗄 수 없다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, product, status: "CLOSED" });
    const scan = await seedScan({ trace_no: world.newTraceNo() });

    const linked = await linkScanToDocumentLineAction(scan.scanId, lineId);

    expect(linked).toEqual({
      success: false,
      error: "마감된 명세서에는 붙일 수 없습니다. 먼저 다시 열어주세요.",
    });

    // DB에 직접 연결해두고(RPC 우회) 뗄 때도 같은 이유로 막히는지 확인한다.
    await adminClient().from("inbound_document_line_scans").insert({
      line_id: lineId,
      scan_id: scan.scanId,
      linked_how: "MANUAL",
    });

    const unlinked = await unlinkScanFromDocumentLineAction(scan.scanId);

    expect(unlinked).toEqual({
      success: false,
      error: "마감된 명세서에서는 뗄 수 없습니다. 먼저 다시 열어주세요.",
    });
  });
});

describe("closeInboundDocumentAction / reopenInboundDocumentAction", () => {
  it("정상 — 미입고가 없으면 사유 없이 마감되고 다시 열 수 있다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();
    const { documentId, lineId } = await world.createDocumentLine({ traceNo, product });
    const scan = await seedScan({ trace_no: traceNo });

    await getActorClient().rpc("link_scan_to_document_line", {
      p_scan_id: scan.scanId,
      p_line_id: lineId,
      p_how: "MANUAL",
    });

    const closed = await closeInboundDocumentAction(documentId, null);

    expect(closed).toEqual({ success: true, data: { incompleteLines: 0 } });

    const { data: docAfterClose } = await adminClient()
      .from("inbound_documents")
      .select("status")
      .eq("id", documentId)
      .single();

    expect(docAfterClose?.status).toBe("CLOSED");

    const reopened = await reopenInboundDocumentAction(documentId);

    expect(reopened).toEqual({ success: true });

    const { data: docAfterReopen } = await adminClient()
      .from("inbound_documents")
      .select("status")
      .eq("id", documentId)
      .single();

    expect(docAfterReopen?.status).toBe("PENDING");
  });

  it("미입고가 있으면 사유 없이는 거부되고, 사유를 적으면 마감된다", async () => {
    const product = await newProduct();
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), product });

    const refused = await closeInboundDocumentAction(documentId, null);

    expect(refused).toEqual({
      success: false,
      error: "미입고 1줄이 있어 사유를 입력해야 마감할 수 있습니다.",
    });

    const closed = await closeInboundDocumentAction(documentId, "공급처 결품 통보");

    expect(closed).toEqual({ success: true, data: { incompleteLines: 1 } });
  });

  it("타 업체 문서는 마감하거나 다시 열 수 없다", async () => {
    const product = await newProduct();
    const { documentId: pendingDocId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), product });
    const { documentId: closedDocId } = await world.createDocumentLine({
      traceNo: world.newTraceNo(),
      product,
      status: "CLOSED",
    });

    await actAs(world.users.ownerB);

    const closeResult = await closeInboundDocumentAction(pendingDocId, "사유");
    const reopenResult = await reopenInboundDocumentAction(closedDocId);

    expect(closeResult).toEqual({ success: false, error: "해당 명세서를 찾을 수 없습니다." });
    expect(reopenResult).toEqual({ success: false, error: "해당 명세서를 찾을 수 없습니다." });
  });

  it("이미 마감된 문서를 또 마감하려 하면 거부되고, 마감 안 된 문서는 다시 열 수 없다", async () => {
    const product = await newProduct();
    const { documentId: closedDocId } = await world.createDocumentLine({
      traceNo: world.newTraceNo(),
      product,
      status: "CLOSED",
    });
    const { documentId: pendingDocId, lineId } = await world.createDocumentLine({
      traceNo: world.newTraceNo(),
      product,
    });
    const scan = await seedScan({ trace_no: world.newTraceNo() });

    await getActorClient().rpc("link_scan_to_document_line", {
      p_scan_id: scan.scanId,
      p_line_id: lineId,
      p_how: "MANUAL",
    });

    const closeAgain = await closeInboundDocumentAction(closedDocId, "사유");
    const reopenPending = await reopenInboundDocumentAction(pendingDocId);

    expect(closeAgain).toEqual({ success: false, error: "이미 마감됐거나 취소된 명세서입니다." });
    expect(reopenPending).toEqual({ success: false, error: "마감된 명세서만 다시 열 수 있습니다." });
  });
});

describe("줄 상태 집계 — 서버 계산이 document_line_match_status RPC와 같은 값을 낸다", () => {
  it("예정 2에 박스 1개만 붙으면 서버 계산(PARTIAL)이 RPC와 일치한다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, product, quantity: 2 });
    const scan = await seedScan({ trace_no: traceNo });

    await getActorClient().rpc("link_scan_to_document_line", {
      p_scan_id: scan.scanId,
      p_line_id: lineId,
      p_how: "MANUAL",
    });

    const { data: rpcRows } = await getActorClient().rpc("document_line_match_status", { p_line_id: lineId });
    const rpcRow = (rpcRows as Array<{ expected: number; linked: number; status: string }>)[0];

    const expected = documentLineExpectedQty(2);
    const linked = 1;
    const status = documentLineMatchStatus(expected, linked);

    expect(rpcRow).toEqual({ expected, linked, status });
    expect(status).toBe("PARTIAL");
  });
});
