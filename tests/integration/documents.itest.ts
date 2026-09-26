/**
 * 29단계 B — 사무실 대조 화면(app/dashboard/inbound/documents/[id]) 서버 액션 4개.
 * DB 함수(link/unlink/close/reopen, 마이그레이션 118) 자체의 동작(자동 배정·중복 창 우회·
 * 취소 시 해제·거슬러 배정)은 tests/integration/inbound.itest.ts의
 * "전표 줄 ↔ 박스 연결" 절이 이미 검증한다. 여기서는 서버 액션 한 겹(권한 매핑·오류 문구)만 본다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World, type WorldProduct } from "./harness";
import {
  closeInboundDocumentAction,
  linkScanToDocumentLineAction,
  reopenInboundDocumentAction,
  setDocumentsScanFinishedAction,
  unlinkScanFromDocumentLineAction,
  updateDocumentLineAction,
} from "@/app/dashboard/inbound/document-actions";
import { documentLineExpectedQty, documentLineMatchStatus, lineArrival } from "@/lib/livestock/document-reconciliation";


// 줄 수정이 번호를 바꾸면 사전조회가 돈다 — 정부 API는 부르지 않는다(인증키 없는 환경처럼).
vi.mock("@/lib/livestock/mtrace-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/livestock/mtrace-client")>();

  return { ...original, isMtraceConfigured: () => false, fetchTraceRecord: vi.fn() };
});

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

    expect(result).toEqual({ success: false, error: "이 전표에 접근할 권한이 없습니다." });
    expect(await linkRow(scan.scanId)).toBeNull();
  });

  it("마감된 전표에는 붙이거나 뗄 수 없다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, product, status: "CLOSED" });
    const scan = await seedScan({ trace_no: world.newTraceNo() });

    const linked = await linkScanToDocumentLineAction(scan.scanId, lineId);

    expect(linked).toEqual({
      success: false,
      error: "마감된 전표에는 붙일 수 없습니다. 먼저 다시 열어주세요.",
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
      error: "마감된 전표에서는 뗄 수 없습니다. 먼저 다시 열어주세요.",
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

    expect(closeResult).toEqual({ success: false, error: "해당 전표를 찾을 수 없습니다." });
    expect(reopenResult).toEqual({ success: false, error: "해당 전표를 찾을 수 없습니다." });
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

    expect(closeAgain).toEqual({ success: false, error: "이미 마감됐거나 취소된 전표입니다." });
    expect(reopenPending).toEqual({ success: false, error: "마감된 전표만 다시 열 수 있습니다." });
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

    expect(rpcRow).toMatchObject({ expected, linked, status, mode: "BOXES" });
    expect(status).toBe("PARTIAL");
  });

  it("무게 기준 줄: 서버 계산(lineArrival)과 RPC가 무게 합계·상태·자리 여부까지 같다", async () => {
    // 개체번호 줄 + 표기 10kg → 자동으로 무게 기준. 세 박스로 나뉘어 와도 합이 표기 ±2% 안이면 다 옴.
    const cases: Array<{ weights: number[]; status: string }> = [
      { weights: [], status: "AWAITING" },
      { weights: [6], status: "PARTIAL" },
      { weights: [3.4, 3.3, 3.2], status: "COMPLETE" },
      { weights: [10.2], status: "COMPLETE" },
      { weights: [10.21], status: "OVER" },
    ];

    for (const { weights, status } of cases) {
      const traceNo = world.newTraceNo();
      const { lineId } = await world.createDocumentLine({ traceNo, quantity: null, labeledWeight: 10 });

      for (const weight of weights) {
        const scan = await seedScan({ trace_no: traceNo, weight });

        await getActorClient().rpc("link_scan_to_document_line", { p_scan_id: scan.scanId, p_line_id: lineId, p_how: "MANUAL" });
      }

      const { data: rpcRows } = await getActorClient().rpc("document_line_match_status", { p_line_id: lineId });
      const rpcRow = (rpcRows as Array<Record<string, unknown>>)[0];
      const arrival = lineArrival({ quantity: null, labeledWeight: 10, traceNo }, weights);

      expect(rpcRow).toMatchObject({ mode: "WEIGHT", status, linked_boxes: weights.length });
      expect(arrival.status).toBe(status);
      expect(Number(rpcRow.linked_weight)).toBeCloseTo(arrival.linkedWeight, 3);
      // SQL의 "자리가 남았나(linked < expected)"가 TS roomLeft와 같아야 자동 배정·중복 창이 어긋나지 않는다.
      expect(Number(rpcRow.linked) < Number(rpcRow.expected)).toBe(arrival.roomLeft);
    }
  });

  it("사무실이 줄 기준을 박스 수로 고정하면 무게가 아니라 박스 수로 판정한다", async () => {
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, quantity: null, labeledWeight: 10 });
    const scan = await seedScan({ trace_no: traceNo, weight: 3 });

    await getActorClient().rpc("link_scan_to_document_line", { p_scan_id: scan.scanId, p_line_id: lineId, p_how: "MANUAL" });

    const before = (await getActorClient().rpc("document_line_match_status", { p_line_id: lineId })).data as Array<Record<string, unknown>>;

    expect(before[0]).toMatchObject({ mode: "WEIGHT", status: "PARTIAL" });

    const set = await getActorClient().rpc("set_document_line_count_mode", { p_line_id: lineId, p_mode: "BOXES" });

    expect(set.data).toBe("BOXES");

    const after = (await getActorClient().rpc("document_line_match_status", { p_line_id: lineId })).data as Array<Record<string, unknown>>;

    expect(after[0]).toMatchObject({ mode: "BOXES", status: "COMPLETE" });
  });

  it("무게가 적히지 않은 줄은 무게 기준으로 못 바꾼다", async () => {
    const { lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 2 });
    const set = await getActorClient().rpc("set_document_line_count_mode", { p_line_id: lineId, p_mode: "WEIGHT" });

    expect(set.error?.message).toContain("NO_LABELED_WEIGHT");
  });

  it("고객·다른 업체는 줄 기준을 바꿀 수 없다", async () => {
    const { lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 2, labeledWeight: 10 });

    await actAs(world.users.retailerR);

    const set = await getActorClient().rpc("set_document_line_count_mode", { p_line_id: lineId, p_mode: "BOXES" });

    expect(set.error?.message).toContain("FORBIDDEN");
  });
});

describe("setDocumentsScanFinishedAction — 현장 스캔 종료 표시", () => {
  async function scanFinishedAt(documentId: string) {
    const { data } = await adminClient()
      .from("inbound_documents")
      .select("scan_finished_at, scan_finished_by")
      .eq("id", documentId)
      .single();

    return data;
  }

  it("정상 — 직원도 종료를 표시하고 다시 시작할 수 있다(표시자가 남는다)", async () => {
    const product = await newProduct();
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), product });

    await actAs(world.users.staffA);

    const finished = await setDocumentsScanFinishedAction([documentId], true);

    expect(finished).toEqual({ success: true, data: { changed: 1 } });

    const marked = await scanFinishedAt(documentId);

    expect(marked?.scan_finished_at).not.toBeNull();
    expect(marked?.scan_finished_by).toBe(world.users.staffA.id);

    const resumed = await setDocumentsScanFinishedAction([documentId], false);

    expect(resumed).toEqual({ success: true, data: { changed: 1 } });
    expect((await scanFinishedAt(documentId))?.scan_finished_at).toBeNull();
  });

  it("표시는 재고나 줄 상태를 바꾸지 않는다", async () => {
    const product = await newProduct();
    const { documentId, lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), product });

    await setDocumentsScanFinishedAction([documentId], true);

    const { data } = await getActorClient().rpc("document_line_match_status", { p_line_id: lineId });

    expect((data as Array<{ status: string }>)[0].status).toBe("AWAITING");
  });

  it("남의 업체 전표는 찾을 수 없다고 거부한다", async () => {
    const product = await newProduct();
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), product });

    await actAs(world.users.ownerB);

    const denied = await setDocumentsScanFinishedAction([documentId], true);

    expect(denied).toMatchObject({ success: false });
    expect((await scanFinishedAt(documentId))?.scan_finished_at).toBeNull();
  });

  it("고객·비로그인 계정은 표시할 수 없다", async () => {
    const product = await newProduct();
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), product });

    await actAs(world.users.retailerR);
    expect(await setDocumentsScanFinishedAction([documentId], true)).toMatchObject({ success: false });

    await actAs(null);
    expect(await setDocumentsScanFinishedAction([documentId], true)).toMatchObject({ success: false });
    expect((await scanFinishedAt(documentId))?.scan_finished_at).toBeNull();
  });

  it("마감된 전표는 건너뛴다(변경 0건)", async () => {
    const product = await newProduct();
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), product, status: "CLOSED" });

    const result = await setDocumentsScanFinishedAction([documentId], true);

    expect(result).toEqual({ success: true, data: { changed: 0 } });
  });
});

describe("전표·전표 줄 직접 수정 잠금 — 로그인한 직원이 API로 고칠 수 없다(마이그레이션 125)", () => {
  async function lineOf(lineId: string) {
    return (await adminClient().from("inbound_document_lines").select("*").eq("id", lineId).single()).data!;
  }

  async function documentOf(documentId: string) {
    return (await adminClient().from("inbound_documents").select("*").eq("id", documentId).single()).data!;
  }

  it("줄의 수량·무게·번호·상품·품목명은 사장이든 직원이든 직접 못 바꾼다(권한 오류), 값은 그대로다", async () => {
    const product = await newProduct();
    const { lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), product, quantity: 2, labeledWeight: 10 });
    const before = await lineOf(lineId);

    for (const actor of [world.users.ownerA, world.users.managerA, world.users.staffA]) {
      await actAs(actor);

      for (const patch of [{ quantity: 99 }, { labeled_weight: 1 }, { trace_no: "000000000000" }, { product_id: null }, { item_name: "바꾼 이름" }, { count_mode: "BOXES" }]) {
        const result = await getActorClient().from("inbound_document_lines").update(patch).eq("id", lineId).select("id");

        expect(result.error, JSON.stringify(patch)).not.toBeNull();
      }
    }

    expect(await lineOf(lineId)).toEqual(before);
  });

  it("사전조회 상태·오류만은 직접 바꿀 수 있다(화면이 하는 일)", async () => {
    const { lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1 });
    const result = await getActorClient()
      .from("inbound_document_lines")
      .update({ prelookup_status: "FAILED", prelookup_error: "확인 필요 번호: 1" })
      .eq("id", lineId)
      .select("id");

    expect(result.error).toBeNull();
    expect(await lineOf(lineId)).toMatchObject({ prelookup_status: "FAILED", prelookup_error: "확인 필요 번호: 1" });
  });

  it("줄을 직접 지울 수 없다(0행)", async () => {
    const { lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1 });
    const result = await getActorClient().from("inbound_document_lines").delete().eq("id", lineId).select("id");

    expect((result.data ?? []).length).toBe(0);
    expect(await lineOf(lineId)).toBeTruthy();
  });

  it("전표를 만든 지 오래됐거나 마감된 전표에는 줄을 새로 넣을 수 없다", async () => {
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1 });
    const fresh = await getActorClient().from("inbound_document_lines").insert({ document_id: documentId, line_no: 2, item_name: "방금 만든 전표에 추가" });

    expect(fresh.error).toBeNull();

    await adminClient().from("inbound_documents").update({ created_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", documentId);
    const old = await getActorClient().from("inbound_document_lines").insert({ document_id: documentId, line_no: 3, item_name: "오래된 전표에 추가" });

    expect(old.error).not.toBeNull();

    const closed = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1, status: "CLOSED" });
    const intoClosed = await getActorClient().from("inbound_document_lines").insert({ document_id: closed.documentId, line_no: 2, item_name: "마감 전표에 추가" });

    expect(intoClosed.error).not.toBeNull();
  });

  it("전표 상태를 직접 마감하거나 마감을 직접 되돌릴 수 없다 — 함수로만 된다", async () => {
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1 });
    const toClosed = await getActorClient().from("inbound_documents").update({ status: "CLOSED" }).eq("id", documentId).select("id");

    expect(toClosed.error?.message).toContain("DOCUMENT_STATUS_CHANGE_DENIED");
    expect((await documentOf(documentId)).status).toBe("PENDING");

    const closedDoc = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1, status: "CLOSED" });
    const toPending = await getActorClient().from("inbound_documents").update({ status: "PENDING" }).eq("id", closedDoc.documentId).select("id");

    expect(toPending.error?.message).toContain("DOCUMENT_STATUS_CHANGE_DENIED");
    expect((await documentOf(closedDoc.documentId)).status).toBe("CLOSED");

    // 정해진 함수로는 그대로 된다.
    expect((await reopenInboundDocumentAction(closedDoc.documentId)).success).toBe(true);
    expect((await documentOf(closedDoc.documentId)).status).toBe("PENDING");
  });

  it("취소 처리와 되살리기는 직접 할 수 있고, 취소하면서 메모를 남길 수 있다", async () => {
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1 });
    const discard = await getActorClient().from("inbound_documents").update({ status: "DISCARDED", note: "품목 저장 실패로 자동 취소됨" }).eq("id", documentId).select("id");

    expect(discard.error).toBeNull();
    expect(await documentOf(documentId)).toMatchObject({ status: "DISCARDED", note: "품목 저장 실패로 자동 취소됨" });

    const restore = await getActorClient().from("inbound_documents").update({ status: "PENDING" }).eq("id", documentId).select("id");

    expect(restore.error).toBeNull();
    expect((await documentOf(documentId)).status).toBe("PENDING");
  });

  it("공급처·전표번호·날짜·금액·스캔 종료 표시·메모는 직접 못 바꾼다", async () => {
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1 });
    const before = await documentOf(documentId);

    for (const patch of [
      { supplier_name: "다른 공급처" },
      { document_no: "9999" },
      { issued_on: "2020-01-01" },
      { total_amount: 1 },
      { entry_method: "MANUAL" },
      { scan_finished_at: new Date().toISOString() },
      { wholesaler_id: world.wholesalerB },
      { note: "메모만 바꾸기" },
    ]) {
      const result = await getActorClient().from("inbound_documents").update(patch).eq("id", documentId).select("id");

      expect(result.error, JSON.stringify(patch)).not.toBeNull();
    }

    const after = await documentOf(documentId);

    expect({ ...after, updated_at: null }).toEqual({ ...before, updated_at: null });
  });

  it("원본 경로는 처음 올릴 때 한 번만 넣을 수 있고 다시 바꿀 수 없다", async () => {
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1 });
    const first = await getActorClient().from("inbound_documents").update({ storage_path: `${world.wholesalerA}/${documentId}/a.pdf` }).eq("id", documentId).select("id");

    expect(first.error).toBeNull();

    const again = await getActorClient().from("inbound_documents").update({ storage_path: "다른/경로.pdf" }).eq("id", documentId).select("id");

    expect(again.error?.message).toContain("DOCUMENT_WRITE_DENIED");
  });

  it("전표를 만들 때 처음부터 마감 상태나 스캔 종료 표시를 넣을 수 없다", async () => {
    const closed = await getActorClient().from("inbound_documents").insert({ wholesaler_id: world.wholesalerA, supplier_name: "직접 생성", status: "CLOSED" });
    const finished = await getActorClient()
      .from("inbound_documents")
      .insert({ wholesaler_id: world.wholesalerA, supplier_name: "직접 생성", status: "PENDING", scan_finished_at: new Date().toISOString() });
    const ok = await getActorClient().from("inbound_documents").insert({ wholesaler_id: world.wholesalerA, supplier_name: "정상 생성", status: "PENDING" });

    expect(closed.error?.message).toContain("DOCUMENT_WRITE_DENIED");
    expect(finished.error?.message).toContain("DOCUMENT_WRITE_DENIED");
    expect(ok.error).toBeNull();
  });

  it("정해진 함수(마감·다시 열기·스캔 종료·줄 기준 바꾸기)는 잠금과 상관없이 그대로 동작한다", async () => {
    const { documentId, lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1, labeledWeight: 10 });

    expect((await setDocumentsScanFinishedAction([documentId], true)).success).toBe(true);
    expect((await documentOf(documentId)).scan_finished_at).not.toBeNull();

    const mode = await getActorClient().rpc("set_document_line_count_mode", { p_line_id: lineId, p_mode: "BOXES" });

    expect(mode.error).toBeNull();
    expect((await lineOf(lineId)).count_mode).toBe("BOXES");

    expect((await closeInboundDocumentAction(documentId, "잠금 테스트")).success).toBe(true);
    expect((await documentOf(documentId)).status).toBe("CLOSED");
    expect((await reopenInboundDocumentAction(documentId)).success).toBe(true);
  });

  it("다른 업체·고객은 여전히 남의 전표를 못 건드린다", async () => {
    const { documentId, lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1 });

    for (const actor of [world.users.ownerB, world.users.retailerR]) {
      await actAs(actor);
      const doc = await getActorClient().from("inbound_documents").update({ status: "DISCARDED" }).eq("id", documentId).select("id");
      const line = await getActorClient().from("inbound_document_lines").update({ prelookup_status: "FAILED" }).eq("id", lineId).select("id");

      expect((doc.data ?? []).length).toBe(0);
      expect((line.data ?? []).length).toBe(0);
    }

    expect((await documentOf(documentId)).status).toBe("PENDING");
  });
});

describe("updateDocumentLineAction — 대조 중 전표의 줄 내용 고치기(마이그레이션 126)", () => {
  async function lineOf(lineId: string) {
    return (await adminClient().from("inbound_document_lines").select("*").eq("id", lineId).single()).data!;
  }

  async function editsOf(lineId: string) {
    return (await adminClient().from("inbound_document_line_edits").select("*").eq("line_id", lineId).order("edited_at")).data ?? [];
  }

  async function linkedScanIds(lineId: string): Promise<string[]> {
    const { data } = await adminClient().from("inbound_document_line_scans").select("scan_id").eq("line_id", lineId);

    return ((data ?? []) as Array<{ scan_id: string }>).map((row) => row.scan_id);
  }

  it("수량을 고치면 값이 바뀌고 도착 판정이 다시 계산되며, 누가 무엇을 바꿨는지 기록이 남는다", async () => {
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, quantity: 5 });
    const scan = await seedScan({ trace_no: traceNo });

    await getActorClient().rpc("link_scan_to_document_line", { p_scan_id: scan.scanId, p_line_id: lineId, p_how: "MANUAL" });

    const before = (await getActorClient().rpc("document_line_match_status", { p_line_id: lineId })).data as Array<{ status: string }>;

    expect(before[0].status).toBe("PARTIAL");

    const result = await updateDocumentLineAction(lineId, { quantity: 1 }, "수량 오타");

    expect(result).toEqual({ success: true, data: { changed: true, changedFields: ["quantity"] } });
    expect(Number((await lineOf(lineId)).quantity)).toBe(1);

    const after = (await getActorClient().rpc("document_line_match_status", { p_line_id: lineId })).data as Array<{ status: string }>;

    expect(after[0].status).toBe("COMPLETE");

    const edits = await editsOf(lineId);

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ reason: "수량 오타", old_values: { quantity: 5 }, new_values: { quantity: 1 }, edited_by: world.users.ownerA.id });
  });

  it("여러 칸을 한 번에 고칠 수 있고 앞뒤 공백·빈 값·번호 소문자가 정리된다", async () => {
    const { lineId } = await world.createDocumentLine({ traceNo: null, partName: "등심", quantity: 2, labeledWeight: 20 });
    const result = await updateDocumentLineAction(lineId, { itemName: "  한우 채끝  ", partName: "", grade: "1++", labeledWeight: 18.5, lotNo: " l20260901000001 " });

    expect(result.success).toBe(true);
    expect(await lineOf(lineId)).toMatchObject({ item_name: "한우 채끝", part_name: null, grade: "1++", trace_no: null, lot_no: "L20260901000001" });
    expect(Number((await lineOf(lineId)).labeled_weight)).toBe(18.5);
    expect((result.data as { changedFields: string[] }).changedFields.sort()).toEqual(["grade", "item_name", "labeled_weight", "lot_no", "part_name"].sort());
  });

  it("번호를 바꾸면 옛 번호로 이어졌던 박스가 풀리고 사전조회가 다시 대기되며, 새 번호의 박스가 이어진다", async () => {
    const oldNo = world.newTraceNo();
    const newNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo: oldNo, quantity: 1 });
    const oldBox = await seedScan({ trace_no: oldNo });
    const newBox = await seedScan({ trace_no: newNo });

    await getActorClient().rpc("link_scan_to_document_line", { p_scan_id: oldBox.scanId, p_line_id: lineId, p_how: "AUTO" });
    expect(await linkedScanIds(lineId)).toEqual([oldBox.scanId]);

    const result = await updateDocumentLineAction(lineId, { traceNo: newNo });

    expect(result.success).toBe(true);
    expect((await lineOf(lineId)).trace_no).toBe(newNo);
    // 옛 번호 박스는 풀리고, 새 번호로 이미 찍혀 있던 박스가 이 줄에 이어진다(전표를 나중에 올린 것과 같은 경로).
    expect(await linkedScanIds(lineId)).toEqual([newBox.scanId]);
    expect((await lineOf(lineId)).prelookup_status).not.toBe("FAILED");
  });

  it("바뀐 게 없으면 changed=false이고 기록도 남지 않는다", async () => {
    const { lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 3 });
    const result = await updateDocumentLineAction(lineId, { quantity: 3 });

    expect(result).toEqual({ success: true, data: { changed: false, changedFields: [] } });
    expect(await editsOf(lineId)).toHaveLength(0);
  });

  it("마감된 전표는 고칠 수 없고 다시 열면 고칠 수 있다", async () => {
    const { documentId, lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 1, status: "CLOSED" });
    const denied = await updateDocumentLineAction(lineId, { quantity: 9 });

    expect(denied.success).toBe(false);
    expect(denied.error).toContain("다시 열기");
    expect(Number((await lineOf(lineId)).quantity)).toBe(1);

    await reopenInboundDocumentAction(documentId);

    expect((await updateDocumentLineAction(lineId, { quantity: 9 })).success).toBe(true);
  });

  it("말이 안 되는 값은 거부한다(수량·중량 0 이하, 단가·금액 음수, 다른 업체 상품)", async () => {
    const { lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 2, labeledWeight: 10 });
    const before = await lineOf(lineId);

    expect((await updateDocumentLineAction(lineId, { quantity: 0 })).error).toContain("수량은(는) 0보다 커야");
    expect((await updateDocumentLineAction(lineId, { labeledWeight: -1 })).error).toContain("중량은(는) 0보다 커야");
    expect((await updateDocumentLineAction(lineId, { unitPrice: -5 })).error).toContain("0 이상");
    expect((await updateDocumentLineAction(lineId, { amount: -5 })).error).toContain("0 이상");

    const otherProduct = await world.createProduct({ stock_quantity: 0, wholesaler: "B" } as never).catch(() => null);

    if (otherProduct) {
      expect((await updateDocumentLineAction(lineId, { productId: otherProduct.id })).error).toContain("상품을 찾을 수 없");
    }

    const unknownField = await getActorClient().rpc("update_inbound_document_line", { p_line_id: lineId, p_patch: { raw_text: "몰래 바꾸기" } });

    expect(unknownField.error?.message).toContain("INVALID_PATCH_FIELD");
    expect(await lineOf(lineId)).toEqual(before);
    expect(await editsOf(lineId)).toHaveLength(0);
  });

  it("값을 비울 수 있다(표기중량을 비우면 무게 기준이 박스 수 기준으로 돌아간다)", async () => {
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, labeledWeight: 10 });
    const before = (await getActorClient().rpc("document_line_match_status", { p_line_id: lineId })).data as Array<{ mode: string }>;

    expect(before[0].mode).toBe("WEIGHT");

    await updateDocumentLineAction(lineId, { labeledWeight: null });

    const after = (await getActorClient().rpc("document_line_match_status", { p_line_id: lineId })).data as Array<{ mode: string }>;

    expect(after[0].mode).toBe("BOXES");
    expect((await lineOf(lineId)).labeled_weight).toBeNull();
  });

  it("직원(staff)은 고칠 수 있고, 다른 업체·고객·비로그인은 못 고친다", async () => {
    const { lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 2 });

    await actAs(world.users.staffA);
    expect((await updateDocumentLineAction(lineId, { quantity: 3 })).success).toBe(true);

    for (const actor of [world.users.ownerB, world.users.retailerR, null]) {
      await actAs(actor);
      expect((await updateDocumentLineAction(lineId, { quantity: 99 })).success).toBe(false);
    }

    expect(Number((await lineOf(lineId)).quantity)).toBe(3);
    expect(await editsOf(lineId)).toHaveLength(1);
  });

  it("수정 기록은 그 업체 직원만 읽을 수 있고 직접 쓰거나 지울 수 없다", async () => {
    const { lineId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), quantity: 2 });

    await updateDocumentLineAction(lineId, { quantity: 4 });

    const mine = await getActorClient().from("inbound_document_line_edits").select("id").eq("line_id", lineId);

    expect((mine.data ?? []).length).toBe(1);

    const write = await getActorClient().from("inbound_document_line_edits").update({ reason: "몰래" }).eq("line_id", lineId).select("id");
    const remove = await getActorClient().from("inbound_document_line_edits").delete().eq("line_id", lineId).select("id");

    expect(write.error ?? (write.data ?? []).length === 0).toBeTruthy();
    expect(remove.error ?? (remove.data ?? []).length === 0).toBeTruthy();
    expect(await editsOf(lineId)).toHaveLength(1);

    await actAs(world.users.ownerB);
    expect(((await getActorClient().from("inbound_document_line_edits").select("id").eq("line_id", lineId)).data ?? []).length).toBe(0);
  });

  it("줄을 고쳐도 재고는 바뀌지 않는다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, product, quantity: 1, labeledWeight: 10 });
    const stockBefore = Number((await adminClient().from("products").select("stock_quantity").eq("id", product.id).single()).data!.stock_quantity);

    await updateDocumentLineAction(lineId, { quantity: 4, labeledWeight: 40, productId: product.id });

    expect(Number((await adminClient().from("products").select("stock_quantity").eq("id", product.id).single()).data!.stock_quantity)).toBe(stockBefore);
  });
});
