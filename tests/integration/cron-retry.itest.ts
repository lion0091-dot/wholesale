/**
 * 이력조회 실패 박스 자동 재조회 크론 — 번호를 정부 이력조회로 다시 물어 공용 캐시에 채운다(박스는 안 바꾼다).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { adminClient, seedWorld, type World } from "./harness";

vi.mock("@/lib/livestock/mtrace-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/livestock/mtrace-client")>();

  return { ...original, fetchTraceRecord: vi.fn(), isMtraceConfigured: vi.fn() };
});

import { fetchTraceRecord, isMtraceConfigured } from "@/lib/livestock/mtrace-client";
import { GET } from "@/app/api/cron/retry-trace-lookups/route";

const fetchMock = vi.mocked(fetchTraceRecord);
const configuredMock = vi.mocked(isMtraceConfigured);

let world: World;

beforeAll(async () => {
  world = await seedWorld();
  process.env.CRON_SECRET = "itest-secret";
});

afterAll(async () => {
  await world?.cleanup();
});

beforeEach(() => {
  fetchMock.mockReset();
  configuredMock.mockReset();
  configuredMock.mockReturnValue(true);
});

function call(secret: string | null) {
  return GET(new NextRequest("http://localhost/api/cron/retry-trace-lookups", { headers: secret ? { authorization: `Bearer ${secret}` } : {} }));
}

async function exceptionScan(traceNo: string) {
  const { data } = await adminClient()
    .from("inbound_scans")
    .insert({ wholesaler_id: world.wholesalerA, trace_no: traceNo, weight: 5, scan_type: "MANUAL", status: "EXCEPTION", remaining_weight: 0 })
    .select("id")
    .single();

  return String(data!.id);
}

describe("GET /api/cron/retry-trace-lookups", () => {
  it("비밀키가 없거나 틀리면 거부한다", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
  });

  it("인증키가 없으면 정부 API를 부르지 않는다", async () => {
    configuredMock.mockReturnValue(false);
    const response = await call("itest-secret");

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("실패 박스의 번호를 이력에서 찾으면 캐시에 채우고 박스에는 시도 시각만 남기며 상태는 바꾸지 않는다", async () => {
    await adminClient().from("inbound_scans").update({ lookup_retried_at: new Date().toISOString() }).eq("status", "EXCEPTION");

    const traceNo = world.newTraceNo();
    const scanId = await exceptionScan(traceNo);

    world.newTraceNo();
    fetchMock.mockResolvedValue({
      traceNo,
      traceKind: "individual",
      source: "mtrace_livestock",
      species: "한우",
      speciesGroup: "소",
      partName: "등심",
      grade: "1++",
      slaughterDate: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
      packingDate: null,
      butcheryPlace: "○○도축장",
      farmName: null,
      originCountry: null,
      importerName: null,
      rawPayload: {},
    });

    const response = await call("itest-secret");
    const body = await response.json();

    expect(body).toMatchObject({ ok: true, checked: 1, cached: 1, failed: 0 });
    expect((await adminClient().from("master_livestock").select("trace_no").eq("trace_no", traceNo).maybeSingle()).data).toEqual({ trace_no: traceNo });

    const scan = (await adminClient().from("inbound_scans").select("status, lookup_retried_at").eq("id", scanId).single()).data!;

    expect(scan.status).toBe("EXCEPTION");
    expect(scan.lookup_retried_at).not.toBeNull();

    // 같은 박스를 바로 다시 돌리면 건너뛴다(20시간 간격).
    fetchMock.mockClear();
    expect((await (await call("itest-secret")).json()).checked).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
