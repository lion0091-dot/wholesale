/**
 * 성능 가드 — 종 배지·입고 화면이 주기적으로 부르는 DB 경로가 데이터가 많을 때도 빠른지 본다.
 * 통합테스트는 보통 행이 몇 개뿐이라 느린 쿼리가 통과한다(82초 걸리던 함수가 그랬다). 여기서 실제 규모(전표 줄 수천 개,
 * 안 이어진 박스 수백~천 개)를 심고 시간 상한을 건다. 상한은 실측(약 10ms)보다 훨씬 넉넉해 CI 편차에는 안 흔들리고,
 * 82초 같은 회귀는 확실히 잡는다.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";
import { GET } from "@/app/api/dashboard/todo-counts/route";

const DOCUMENTS = 150;
const LINES_PER_DOCUMENT = 30;
const UNLINKED_SCANS = 900;
const NUMBERLESS_OPEN_LINES = 20;
const LIMIT_MS = 1500;

let world: World;
const documentIds: string[] = [];
const scanIds: string[] = [];

async function insertChunks(table: string, rows: Array<Record<string, unknown>>, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await adminClient().from(table).insert(rows.slice(i, i + size));

    expect(error, `${table} 시드`).toBeNull();
  }
}

beforeAll(async () => {
  world = await seedWorld();

  const documents = Array.from({ length: DOCUMENTS }, (_, index) => {
    const id = randomUUID();

    documentIds.push(id);

    return {
      id,
      wholesaler_id: world.wholesalerA,
      supplier_name: `성능-${world.runId}-${index}`,
      document_no: `PERF-${world.runId}-${index}`,
      status: index % 10 === 0 ? "PENDING" : "CLOSED",
    };
  });

  await insertChunks("inbound_documents", documents);

  const lines: Array<Record<string, unknown>> = [];

  documents.forEach((doc, docIndex) => {
    for (let n = 1; n <= LINES_PER_DOCUMENT; n += 1) {
      // 대기 전표(10번째마다)의 앞쪽 몇 줄은 번호 없는 줄 — 부위로 잇는 계산이 돌게 한다.
      const numberless = doc.status === "PENDING" && n <= Math.ceil(NUMBERLESS_OPEN_LINES / (DOCUMENTS / 10));

      lines.push({
        id: randomUUID(),
        document_id: doc.id,
        line_no: n,
        raw_text: "x",
        trace_no: numberless ? null : String(100000000000 + docIndex * 100 + n),
        part_name: "등심",
        labeled_weight: numberless ? 10 : null,
      });
    }
  });

  await insertChunks("inbound_document_lines", lines);

  const scans = Array.from({ length: UNLINKED_SCANS }, (_, index) => {
    const id = randomUUID();

    scanIds.push(id);

    return {
      id,
      wholesaler_id: world.wholesalerA,
      // 절반은 아무 전표와도 안 맞는 번호(전표 없이 찍은 박스), 나머지는 마감 전표 줄과 같은 번호(뒤늦게 온 박스).
      trace_no: index % 2 === 0 ? String(900000000000 + index) : String(100000000000 + (index % DOCUMENTS) * 100 + 1),
      weight: 5,
      unit: "kg",
      scan_type: "MANUAL",
      status: "NORMAL",
      remaining_weight: 5,
    };
  });

  await insertChunks("inbound_scans", scans);
});

afterAll(async () => {
  await adminClient().from("inbound_scans").delete().in("id", scanIds);
  await adminClient().from("inbound_documents").delete().in("id", documentIds);
  await world?.cleanup();
});

describe("성능 가드 — 큰 데이터에서도 주기적으로 부르는 경로가 빠르다", () => {
  it(`안 이어진 박스 조회(list_unlinked_boxes_for_documents)가 줄 ${DOCUMENTS * LINES_PER_DOCUMENT}개·박스 ${UNLINKED_SCANS}개에서 ${LIMIT_MS}ms 안이고, 심어 둔 뒤늦은 박스를 찾는다`, async () => {
    await actAs(world.users.ownerA);

    const started = performance.now();
    const { data, error } = await getActorClient().rpc("list_unlinked_boxes_for_documents", { p_wholesaler_id: world.wholesalerA });
    const elapsed = performance.now() - started;

    expect(error).toBeNull();
    expect(elapsed, `걸린 시간 ${Math.round(elapsed)}ms`).toBeLessThan(LIMIT_MS);

    const rows = (data ?? []) as Array<{ scan_id: string; document_status: string }>;

    // 번호가 맞는 박스가 실제로 잡혀야 한다(빠르기만 하고 텅 빈 결과를 돌려주는 회귀도 막는다).
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.document_status === "CLOSED" || row.document_status === "PENDING")).toBe(true);
  });

  it(`종 배지 API(/api/dashboard/todo-counts) 전체가 ${LIMIT_MS}ms 안이다`, async () => {
    await actAs(world.users.ownerA);

    const started = performance.now();
    const response = await GET();
    const elapsed = performance.now() - started;
    const body = (await response.json()) as { counts: { lateBoxes: number } | null };

    expect(elapsed, `걸린 시간 ${Math.round(elapsed)}ms`).toBeLessThan(LIMIT_MS);
    expect(body.counts).not.toBeNull();
    expect(body.counts!.lateBoxes).toBeGreaterThan(0);
  });

  it("함수를 연달아 5번 불러도 매번 상한 안이다(캐시된 계획 때문에 느려지는 회귀 방지)", async () => {
    await actAs(world.users.ownerA);

    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();

      await getActorClient().rpc("list_unlinked_boxes_for_documents", { p_wholesaler_id: world.wholesalerA });

      const elapsed = performance.now() - started;

      expect(elapsed, `${i + 1}번째 ${Math.round(elapsed)}ms`).toBeLessThan(LIMIT_MS);
    }
  });

  it(`전표 대조 화면의 번호 매칭(match_document_lines_for_traces)이 박스 번호 300개에서 ${LIMIT_MS}ms 안이다`, async () => {
    await actAs(world.users.ownerA);

    const traces = scanIds.slice(0, 300).map((_, index) => String(900000000000 + index * 2));
    // 마감 전표 줄과 같은 번호도 섞어 넣어 실제로 일치하는 행이 나오는지 함께 본다.
    traces.push(String(100000000000 + 1), String(100000000000 + 101));

    const started = performance.now();
    const { data, error } = await getActorClient().rpc("match_document_lines_for_traces", { p_wholesaler_id: world.wholesalerA, p_trace_nos: traces });
    const elapsed = performance.now() - started;

    expect(error).toBeNull();
    expect(elapsed, `걸린 시간 ${Math.round(elapsed)}ms`).toBeLessThan(LIMIT_MS);
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it(`입고 화면의 '아직 안 만난 줄' 조회(list_awaiting_document_line_ids)가 ${LIMIT_MS}ms 안이다`, async () => {
    await actAs(world.users.ownerA);

    const started = performance.now();
    const { error } = await getActorClient().rpc("list_awaiting_document_line_ids", { p_wholesaler_id: world.wholesalerA });
    const elapsed = performance.now() - started;

    expect(error).toBeNull();
    expect(elapsed, `걸린 시간 ${Math.round(elapsed)}ms`).toBeLessThan(LIMIT_MS);
  });

  it(`박스 번호 하나로 전표 줄을 찾는 단건 경로(lookup_document_part_name → document_lines_matching_trace)가 40번 연달아 ${LIMIT_MS}ms 안이다`, async () => {
    await actAs(world.users.ownerA);

    const started = performance.now();
    let found: unknown = null;

    for (let i = 0; i < 40; i += 1) {
      // 없는 번호와 있는 번호를 번갈아 부른다(스캔 하나가 이 경로를 여러 번 탄다).
      const traceNo = i % 2 === 0 ? String(100000000000 + i * 100 + 3) : String(700000000000 + i);
      const { data, error } = await getActorClient().rpc("lookup_document_part_name", { p_wholesaler_id: world.wholesalerA, p_trace_no: traceNo });

      expect(error).toBeNull();

      if (i === 0) {
        found = data;
      }
    }

    const elapsed = performance.now() - started;

    expect(elapsed, `40번 ${Math.round(elapsed)}ms`).toBeLessThan(LIMIT_MS);
    expect(found).toBe("등심");
  });

  it("동시에 20명이 종 배지와 안 이어진 박스 조회를 불러도 전부 상한 안에 끝난다(부하)", async () => {
    await actAs(world.users.ownerA);

    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => getActorClient().rpc("list_unlinked_boxes_for_documents", { p_wholesaler_id: world.wholesalerA }))
    );
    const elapsed = performance.now() - started;

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(elapsed, `20건 동시 ${Math.round(elapsed)}ms`).toBeLessThan(LIMIT_MS * 2);
  });
});
