/**
 * docs/test-samples/ 의 실제 샘플 전표 파일을 그대로 읽어 전표입력 → 저장 → 박스 스캔 → 대조·자동 마감까지 돌린다.
 * 시험표(00-시험표.xlsx)의 "기대 결과"를 서버 액션 수준에서 확인한다. 화면 클릭·실계정 이력조회는 여기 범위 밖이다.
 * 샘플 번호는 가짜라 world.seedTrace로 이력 캐시를 심어 "이력조회가 성공한" 상황을 만든다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World } from "./harness";
import { extractExcelTableAction, saveInboundDocumentAction } from "@/app/dashboard/inbound/document-actions";
import { recordScanAction, type ScanResult } from "@/app/dashboard/inbound/actions";
import { decodeDocumentFileText } from "@/lib/livestock/document-file-text";
import { applyColumnMap, buildGrid, parseDocumentText } from "@/lib/livestock/document-parser";

const SAMPLE_DIR = path.resolve(__dirname, "../../docs/test-samples");

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

function readSample(name: string): Buffer {
  return readFileSync(path.join(SAMPLE_DIR, name));
}

function linesOfCsv(name: string) {
  const grid = parseDocumentText(decodeDocumentFileText(readSample(name)));

  return { grid, lines: applyColumnMap(grid, grid.columnMap) };
}

async function saveLines(supplierName: string, lines: ReturnType<typeof applyColumnMap>): Promise<{ documentId: string; lineIds: string[] }> {
  const form = new FormData();

  form.append("payload", JSON.stringify({ supplierName: `${supplierName}-${world.runId}`, lines: lines.map((line) => ({ ...line, productId: null })) }));

  const saved = await saveInboundDocumentAction(form);

  expect(saved.success).toBe(true);

  const documentId = (saved.data as { documentId: string }).documentId;
  const { data } = await adminClient().from("inbound_document_lines").select("id").eq("document_id", documentId).order("line_no");

  return { documentId, lineIds: ((data ?? []) as Array<{ id: string }>).map((row) => row.id) };
}

async function scanBox(traceNo: string, weight: number, part: string | null, seed: boolean | "돼지" = true): Promise<ScanResult> {
  if (seed) await world.seedTrace(traceNo, { part, grade: null, speciesGroup: seed === "돼지" ? "돼지" : "소" });

  const result = await recordScanAction({ traceNo, weight, scanType: "BARCODE_SCAN" });

  expect(result.success).toBe(true);

  return result.data as ScanResult;
}

async function lineStatus(lineId: string) {
  const { data, error } = await adminClient().rpc("document_line_match_status", { p_line_id: lineId });

  expect(error).toBeNull();

  const row = (data as Array<{ status: string; linked_boxes: number; linked_weight: number | null; mode: string }>)[0];

  return { status: row.status, boxes: Number(row.linked_boxes), weight: Number(row.linked_weight ?? 0), mode: row.mode };
}

async function docStatus(documentId: string) {
  const { data } = await adminClient().from("inbound_documents").select("status").eq("id", documentId).single();

  return String(data?.status);
}

async function linkedLine(scanId: string): Promise<string | null> {
  const { data } = await adminClient().from("inbound_document_line_scans").select("line_id").eq("scan_id", scanId).maybeSingle();

  return (data?.line_id as string | undefined) ?? null;
}

describe("샘플 1 — 대성축산: 개체번호 줄은 무게로 센다", () => {
  it("칸이 저절로 잡히고, 같은 번호 3박스가 한 줄에 이어져 10kg에서 다 온 것이 된다. 세 줄을 다 채우면 저절로 마감된다", async () => {
    const { grid, lines } = linesOfCsv("1-대성축산-개체번호와중량.csv");

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.traceNo)).toEqual(["002191840011", "002191840022", "002191840033"]);
    expect(lines.map((line) => line.labeledWeight)).toEqual([10, 4.5, 8.2]);
    expect(lines.map((line) => line.partName)).toEqual(["등심", "안심", "채끝"]);
    expect(grid.columnMap).toBeTruthy();

    const { documentId, lineIds } = await saveLines("대성축산", lines);

    const b1 = await scanBox("002191840011", 3.4, "등심");
    const b2 = await scanBox("002191840011", 3.3, "등심", false);

    expect(await linkedLine(b1.scanId)).toBe(lineIds[0]);
    expect(await linkedLine(b2.scanId)).toBe(lineIds[0]);
    expect((await lineStatus(lineIds[0])).status).not.toBe("COMPLETE");
    expect(await docStatus(documentId)).toBe("PENDING");

    await scanBox("002191840011", 3.3, "등심", false);

    const first = await lineStatus(lineIds[0]);

    expect(first).toMatchObject({ status: "COMPLETE", boxes: 3, mode: "WEIGHT" });
    expect(first.weight).toBeCloseTo(10, 1);
    expect(await docStatus(documentId)).toBe("PENDING");

    await scanBox("002191840022", 4.5, "안심");
    const last = await scanBox("002191840033", 8.2, "채끝");

    expect(last.autoClosedDocument).toBe(true);
    expect(await docStatus(documentId)).toBe("CLOSED");
  });
});

describe("샘플 2 — 한우마을: 로트번호 줄은 박스 수로 센다(헤더 이름이 달라도 칸이 잡힌다)", () => {
  it("'이력(묶음)번호'가 번호로, '박스'가 수량으로 잡히고, 3박스가 이어져야 다 온 것이다", async () => {
    const { lines } = linesOfCsv("2-한우마을-로트번호와박스수.csv");

    expect(lines.map((line) => [line.traceNo, line.quantity, line.labeledWeight])).toEqual([
      ["L20260926000101", 3, 30],
      ["L20260926000102", 2, 20],
    ]);

    const { lineIds } = await saveLines("한우마을", lines);

    await world.seedTrace("L20260926000101", { traceKind: "group", part: "갈비", grade: null });

    const b1 = await scanBox("L20260926000101", 10, "갈비", false);
    const b2 = await scanBox("L20260926000101", 10, "갈비", false);

    expect(await linkedLine(b1.scanId)).toBe(lineIds[0]);
    expect((await lineStatus(lineIds[0])).status).not.toBe("COMPLETE");
    expect(await linkedLine(b2.scanId)).toBe(lineIds[0]);

    await scanBox("L20260926000101", 10, "갈비", false);

    expect(await lineStatus(lineIds[0])).toMatchObject({ status: "COMPLETE", boxes: 3, mode: "BOXES" });
  });
});

describe("샘플 3 — 돈육상사(엑셀): 두 칸 서식·쉼표 숫자", () => {
  it("엑셀이 읽히고 묶음번호·개체번호가 따로 잡히며, 개체번호로 스캔하면 각 줄에 이어진다", async () => {
    const form = new FormData();

    form.append("file", new File([new Uint8Array(readSample("3-돈육상사-두칸서식.xlsx"))], "3-돈육상사.xlsx"));

    const extracted = await extractExcelTableAction(form);

    expect(extracted.success).toBe(true);

    const grid = buildGrid(extracted.data!.cells);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.lotNo)).toEqual(["L20260926000201", "L20260926000201", "L20260926000202"]);
    expect(lines.map((line) => line.traceNo)).toEqual(["100770123456", "100770123457", "100770123458"]);
    expect(lines.map((line) => line.unitPrice)).toEqual([13000, 13000, 11000]);

    // 첫 칸 "번호"(일련번호 1·2·3)를 등급으로 오인하지 않는다.
    expect(lines.map((line) => line.grade)).toEqual([null, null, null]);

    const { lineIds } = await saveLines("돈육상사", lines);
    const a = await scanBox("100770123456", 12.5, "삼겹살");
    const b = await scanBox("100770123457", 12.3, "삼겹살");

    expect(await linkedLine(a.scanId)).toBe(lineIds[0]);
    expect(await linkedLine(b.scanId)).toBe(lineIds[1]);
  });
});

describe("샘플 4 — 혼합유통: 한 전표 안에서 줄마다 세는 기준이 다르다", () => {
  it("등심(개체·무게)·갈비(로트·박스)·삼겹살(번호 없음·무게)이 각자 기준으로 판정되고, 번호 없는 줄은 부위로 이어진다", async () => {
    const { lines } = linesOfCsv("4-혼합유통-혼합전표.csv");

    expect(lines).toHaveLength(3);
    expect(lines[2].traceNo).toBeNull();

    const { documentId, lineIds } = await saveLines("혼합유통", lines);

    expect((await lineStatus(lineIds[0])).mode).toBe("WEIGHT");
    expect((await lineStatus(lineIds[1])).mode).toBe("BOXES");
    expect((await lineStatus(lineIds[2])).mode).toBe("WEIGHT");

    await scanBox("002191840044", 4, "등심");
    await scanBox("002191840044", 6, "등심", false);
    expect((await lineStatus(lineIds[0])).status).toBe("COMPLETE");

    await world.seedTrace("L20260926000301", { traceKind: "group", part: "갈비", grade: null });
    await scanBox("L20260926000301", 10, "갈비", false);
    await scanBox("L20260926000301", 10, "갈비", false);
    expect((await lineStatus(lineIds[1])).status).not.toBe("COMPLETE");
    await scanBox("L20260926000301", 10, "갈비", false);
    expect((await lineStatus(lineIds[1])).status).toBe("COMPLETE");

    expect(await docStatus(documentId)).toBe("PENDING");

    const pork = await scanBox(world.newTraceNo(), 20, "삼겹살", "돼지");

    expect(await linkedLine(pork.scanId)).toBe(lineIds[2]);
    expect((await lineStatus(lineIds[2])).status).toBe("COMPLETE");
    expect(await docStatus(documentId)).toBe("CLOSED");
  });

  it("부위가 다른 박스는 번호 없는 줄에 안 이어진다", async () => {
    const { lines } = linesOfCsv("4-혼합유통-혼합전표.csv");
    const { lineIds } = await saveLines("혼합유통-오배정", [lines[2]]);
    const wrong = await scanBox(world.newTraceNo(), 20, "목심", "돼지");

    expect(await linkedLine(wrong.scanId)).toBeNull();
    expect((await lineStatus(lineIds[0])).status).not.toBe("COMPLETE");
  });
});

describe("샘플 5 — 새벽식품: 번호가 하나도 없는 전표", () => {
  it("부위·무게로 이어지고, 후보가 하나일 때만 자동으로 이어진다", async () => {
    const { lines } = linesOfCsv("5-새벽식품-번호없는전표.csv");

    expect(lines.map((line) => [line.itemName, line.partName, line.quantity, line.labeledWeight, line.traceNo])).toEqual([
      ["한우 목심", "목심", 2, 20, null],
      ["한우 앞다리", "앞다리", 1, 12, null],
    ]);

    const { documentId, lineIds } = await saveLines("새벽식품", lines);

    const c1 = await scanBox(world.newTraceNo(), 10, "목심");
    const c2 = await scanBox(world.newTraceNo(), 10, "목심");
    const front = await scanBox(world.newTraceNo(), 12, "앞다리");

    expect(await linkedLine(c1.scanId)).toBe(lineIds[0]);
    expect(await linkedLine(c2.scanId)).toBe(lineIds[0]);
    expect(await linkedLine(front.scanId)).toBe(lineIds[1]);
    expect(await docStatus(documentId)).toBe("CLOSED");
  });
});

describe("샘플 6 — 허브식품: 이상 케이스", () => {
  it("11자리 오타·소문자 로트·한 칸에 번호 둘을 어떻게 읽는지 확인하고 저장은 된다", async () => {
    const { lines } = linesOfCsv("6-허브식품-이상케이스.csv");
    const byPart = Object.fromEntries(lines.map((line) => [line.partName, line]));

    expect(byPart["목심"].traceNo).toBe("002191840055");
    // 11자리는 앞에 0이 붙어 12자리로 보정된다(엑셀이 앞 0을 지운 경우를 위한 것).
    expect(byPart["설도"].traceNo).toBe("000219184006");
    expect(byPart["사태"].traceNo).toBe("L20260926000401");
    // 한 칸에 번호 둘이면 줄이 둘로 나뉜다.
    expect(lines.filter((line) => line.partName === "우둔").map((line) => line.traceNo)).toEqual(["002191840071", "002191840072"]);

    const { documentId } = await saveLines("허브식품", lines);

    expect(await docStatus(documentId)).toBe("PENDING");

    // 같은 번호가 대기 전표 두 장에 있으면 자동으로 잇지 않는다(설계) — 다음 테스트가 겹치지 않게 치운다.
    await adminClient().from("inbound_documents").update({ status: "DISCARDED" }).eq("id", documentId);
  });

  it("무게·수량이 없는 줄에 세 박스가 오면 첫 박스에서 마감되고 뒤 박스는 '마감된 전표 뒤에 온 박스'로 조회된다", async () => {
    const { lines } = linesOfCsv("6-허브식품-이상케이스.csv");
    const { documentId } = await saveLines("허브식품-목심", [lines.find((line) => line.partName === "목심")!]);

    const first = await scanBox("002191840055", 3, "목심");

    expect(first.autoClosedDocument).toBe(true);
    expect(await docStatus(documentId)).toBe("CLOSED");

    const second = await scanBox("002191840055", 3.1, "목심", false);
    const third = await scanBox("002191840055", 4, "목심", false);

    expect(second.matchedClosedDocument).toBe(true);

    const { data } = await (await import("./harness")).getActorClient().rpc("list_unlinked_boxes_for_documents", { p_wholesaler_id: world.wholesalerA });
    const lateIds = ((data ?? []) as Array<{ scan_id: string }>).map((row) => row.scan_id);

    expect(lateIds).toEqual(expect.arrayContaining([second.scanId, third.scanId]));
  });
});

describe("같은 번호가 대기 전표 두 장에 있을 때 — 박스가 어디에도 안 이어지고, 사무실 카드가 대조 화면으로 데려간다", () => {
  it("자동으로 잇지 않은 박스가 '안 이어진 박스' 조회에 잡히고, 이어 주면 사라진다", async () => {
    const trace = world.newTraceNo();
    const first = await world.createDocumentLine({ traceNo: trace, itemName: "한우 갈비", partName: "갈비", labeledWeight: 10 });
    const second = await world.createDocumentLine({ traceNo: trace, itemName: "한우 갈비", partName: "갈비", labeledWeight: 10 });
    const box = await scanBox(trace, 10, "갈비");

    expect(await linkedLine(box.scanId)).toBeNull();

    const { getActorClient } = await import("./harness");
    const list = async () => {
      const { data } = await getActorClient().rpc("list_unlinked_boxes_for_documents", { p_wholesaler_id: world.wholesalerA });

      return ((data ?? []) as Array<{ scan_id: string; document_id: string; document_status: string }>).filter((row) => row.scan_id === box.scanId);
    };

    const before = await list();

    expect(before).toHaveLength(1);
    expect(before[0].document_status).toBe("PENDING");
    expect([first.documentId, second.documentId]).toContain(before[0].document_id);

    const { linkScanToDocumentLineAction } = await import("@/app/dashboard/inbound/document-actions");

    expect((await linkScanToDocumentLineAction(box.scanId, first.lineId)).success).toBe(true);
    expect(await list()).toEqual([]);
  });
});

describe("번호 없는 줄 — 부위가 같은데 자동으로 안 이어진 박스는 사무실 카드가 대조 화면으로 데려간다", () => {
  it("무게가 크게 달라 안 이어진 같은 부위 박스는 조회에 잡히고, 부위가 다른 박스는 안 잡히며, 이어 주면 사라진다", async () => {
    const { getActorClient } = await import("./harness");
    const line = await world.createDocumentLine({ traceNo: null, itemName: "돈육 삼겹살", partName: "삼겹살", labeledWeight: 20 });
    const heavy = await scanBox(world.newTraceNo(), 45, "삼겹살", "돼지");
    const other = await scanBox(world.newTraceNo(), 20, "목심", "돼지");

    expect(await linkedLine(heavy.scanId)).toBeNull();

    const list = async () => {
      const { data } = await getActorClient().rpc("list_unlinked_boxes_for_documents", { p_wholesaler_id: world.wholesalerA });

      return ((data ?? []) as Array<{ scan_id: string; document_id: string; document_status: string }>).filter((row) =>
        [heavy.scanId, other.scanId].includes(row.scan_id)
      );
    };

    const found = await list();

    expect(found.map((row) => row.scan_id)).toEqual([heavy.scanId]);
    // 같은 부위의 안 찬 번호 없는 줄이 대기 전표 여럿에 있으면 가장 오래된 전표로 안내한다(앞 테스트가 남긴 전표일 수 있다).
    expect(found[0].document_status).toBe("PENDING");
    expect(found[0].document_id).toBeTruthy();
    expect(line.documentId).toBeTruthy();

    const { linkScanToDocumentLineAction } = await import("@/app/dashboard/inbound/document-actions");

    expect((await linkScanToDocumentLineAction(heavy.scanId, line.lineId)).success).toBe(true);
    expect(await list()).toEqual([]);
  });
});
