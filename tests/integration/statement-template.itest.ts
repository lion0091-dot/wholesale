/**
 * 명세서 입력 양식(.xlsx) — 내려받기 경로와 "채운 엑셀을 바로 올리기" 서버 액션.
 * 양식 생성·엑셀 읽기·헤더 인식 자체는 lib/livestock/excel-statement.test.ts가 한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import writeExcelFile from "write-excel-file/node";
import { actAs, adminClient, seedWorld, type World } from "./harness";
import { extractExcelTableAction, saveInboundDocumentAction } from "@/app/dashboard/inbound/document-actions";
import { recordScanAction, type ScanResult } from "@/app/dashboard/inbound/actions";
import { GET as downloadTemplate } from "@/app/dashboard/inbound/statement-template/route";
import { STATEMENT_TEMPLATE_HEADERS, STATEMENT_TEMPLATE_SHEET } from "@/lib/livestock/statement-template";
import { applyColumnMap, buildGrid } from "@/lib/livestock/document-parser";

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

function xlsxForm(bytes: Uint8Array | Buffer, name = "채운양식.xlsx"): FormData {
  const form = new FormData();

  form.append("file", new File([new Uint8Array(bytes)], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

  return form;
}

async function filledWorkbook(rows: unknown[][]): Promise<Buffer> {
  return writeExcelFile([{ data: [STATEMENT_TEMPLATE_HEADERS.map((value) => ({ value })), ...rows] as never, sheet: STATEMENT_TEMPLATE_SHEET }] as never).toBuffer();
}

describe("양식 내려받기", () => {
  it("공급사 계정은 xlsx 양식을 받고(한글 파일명 헤더 포함), 고객·비로그인은 401이다", async () => {
    const response = await downloadTemplate();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toContain("filename*=UTF-8''");
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");

    await actAs(world.users.retailerR);
    expect((await downloadTemplate()).status).toBe(401);

    await actAs(null);
    expect((await downloadTemplate()).status).toBe(401);
  });
});

describe("채운 양식을 바로 올리기 — 엑셀 읽기 → 저장 → 박스 스캔", () => {
  it("양식에 적은 줄이 읽히고, 저장한 뒤 박스를 찍으면 부위 이름 그대로 상품이 만들어진다(숫자로 저장돼 앞 0이 지워진 번호 포함)", async () => {
    const traceA = world.newTraceNo();
    const traceB = world.newTraceNo();
    const workbook = await filledWorkbook([
      ["한우 안심", "안심", "1++", "국내산", { value: traceA, type: String }, null, 1, 7.1, 90000, 639000],
      ["한우 채끝", "채끝", "1+", "국내산", { value: Number(traceB), type: Number }, null, 1, 9.8, 70000, 686000],
    ]);
    const extracted = await extractExcelTableAction(xlsxForm(workbook));

    expect(extracted.success).toBe(true);
    expect(extracted.data!.sheetName).toBe(STATEMENT_TEMPLATE_SHEET);

    const grid = buildGrid(extracted.data!.cells);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines.map((line) => line.traceNo)).toEqual([traceA, traceB]);
    expect(lines.map((line) => line.partName)).toEqual(["안심", "채끝"]);

    const form = new FormData();

    form.append("payload", JSON.stringify({ supplierName: `양식축산-${world.runId}`, lines: lines.map((line) => ({ ...line, productId: null })) }));
    form.append("file", new File([new Uint8Array(workbook)], "공급처 명세서.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

    const saved = await saveInboundDocumentAction(form);

    expect(saved.success).toBe(true);

    await world.seedTrace(traceA, { part: null, grade: null });
    await world.seedTrace(traceB, { part: null, grade: null });

    const a = (await recordScanAction({ traceNo: traceA, weight: 7.1, scanType: "BARCODE_SCAN" })).data as ScanResult;
    const b = (await recordScanAction({ traceNo: traceB, weight: 9.8, scanType: "BARCODE_SCAN" })).data as ScanResult;
    const { data: products } = await adminClient().from("products").select("subcategory").in("id", [a.productId!, b.productId!]);

    expect((products ?? []).map((row) => row.subcategory).sort()).toEqual(["안심", "채끝"]);

    const { data: doc } = await adminClient().from("inbound_documents").select("file_name, storage_path").eq("id", (saved.data as { documentId: string }).documentId).single();

    expect(doc?.file_name).toBe("공급처 명세서.xlsx");
    expect(doc?.storage_path).toMatch(/\.xlsx$/);
  });

  it("빈 양식(헤더만)은 줄이 없어 화면이 안내를 띄울 수 있게 빈 줄 목록이 나오고, 깨진 파일·큰 파일·고객 계정은 거부된다", async () => {
    const template = (await (await (await import("@/lib/livestock/statement-template")).buildStatementTemplate()));
    const emptyForm = await extractExcelTableAction(xlsxForm(template));

    expect(emptyForm.success).toBe(true);

    const grid = buildGrid(emptyForm.data!.cells);

    expect(applyColumnMap(grid, grid.columnMap)).toHaveLength(0);

    expect((await extractExcelTableAction(xlsxForm(new TextEncoder().encode("엑셀이 아닙니다"), "가짜.xlsx"))).success).toBe(false);
    expect(await extractExcelTableAction(xlsxForm(new Uint8Array(8 * 1024 * 1024 + 1)))).toEqual({ success: false, error: "파일이 너무 큽니다. 8MB 이하로 올려주세요." });

    await actAs(world.users.retailerR);
    expect((await extractExcelTableAction(xlsxForm(template))).success).toBe(false);
  });
});

describe("화면에서 직접 입력한 줄(entryMethod MANUAL) — 사진을 보면서 옮겨 적은 종이 명세서", () => {
  it("직접 입력한 줄이 저장되고 사진 원본이 함께 보관되며, 박스를 찍으면 명세서 줄에 자동으로 이어진다", async () => {
    const trace = world.newTraceNo();
    const form = new FormData();

    form.append(
      "payload",
      JSON.stringify({
        supplierName: `직접입력축산-${world.runId}`,
        entryMethod: "MANUAL",
        columnMap: null,
        lines: [{ lineNo: 1, raw: "", itemName: "한우 양지", traceNo: trace, partName: "양지", grade: "1", quantity: 1, labeledWeight: 8.5, unitPrice: 20000, amount: 170000, productId: null }],
      })
    );
    form.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], "종이 명세서 사진.JPG", { type: "image/jpeg" }));

    const saved = await saveInboundDocumentAction(form);

    expect(saved.success).toBe(true);

    const documentId = (saved.data as { documentId: string }).documentId;
    const { data: doc } = await adminClient().from("inbound_documents").select("storage_path, entry_method").eq("id", documentId).single();
    const { data: lines } = await adminClient().from("inbound_document_lines").select("id, part_name, item_name").eq("document_id", documentId);

    expect(doc?.storage_path).toBeTruthy();
    expect(lines).toHaveLength(1);
    expect(lines![0]).toMatchObject({ part_name: "양지", item_name: "한우 양지" });

    await world.seedTrace(trace, { part: null, grade: null });

    const scan = (await recordScanAction({ traceNo: trace, weight: 8.5, scanType: "BARCODE_SCAN" })).data as ScanResult;
    const { data: link } = await adminClient().from("inbound_document_line_scans").select("line_id").eq("scan_id", scan.scanId).maybeSingle();

    expect(link?.line_id).toBe(lines![0].id);
  });
});
