/**
 * 엑셀 대량 입고 — 냉장/냉동(셋째 칸)·부위(넷째 칸) 열(마이그레이션 180·181).
 * 공공 이력조회는 부위·냉장/냉동을 주지 않으므로(부위 없는 이력으로 시드) 엑셀 칸이 상품을 정한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World } from "./harness";
import { createImportJobAction, processImportChunkAction } from "@/app/dashboard/inbound/actions";

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

type Row = { storageHint: "냉장" | "냉동" | null; partHint: string | null };

async function importRows(rows: Row[]) {
  const withTrace = [];

  for (const [index, row] of rows.entries()) {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, grade: "1+", originCountry: "국내산" });
    withTrace.push({ rowNo: index + 1, traceNo, weight: 10, ...row });
  }

  const created = await createImportJobAction({ fileName: "t", rows: withTrace });

  return { created, withTrace };
}

async function drain(jobId: string) {
  let result = await processImportChunkAction(jobId);

  while (result.success && !result.data?.finished) {
    result = await processImportChunkAction(jobId);
  }
}

async function scanProducts(traceNos: string[]) {
  const { data } = await adminClient()
    .from("inbound_scans")
    .select("trace_no, status, product_id, products(subcategory, storage_state)")
    .in("trace_no", traceNos);

  return (data ?? []) as unknown as Array<{
    trace_no: string;
    status: string;
    product_id: string | null;
    products: { subcategory: string | null; storage_state: string | null } | null;
  }>;
}

describe("엑셀 대량 입고 — 냉장/냉동·부위 열", () => {
  it("부위 칸은 이미 등록된 부위의 기존 상품에 붙고, 냉장/냉동을 비우면 확인 필요로 보관된다", async () => {
    const part = `엑셀부위-${world.runId}`;
    const { data: existing } = await adminClient()
      .from("products")
      .insert({ wholesaler_id: world.wholesalerA, name: `냉장 한우 ${part} 1+`, category: "소", breed: "한우", subcategory: part, grade: "1+", origin: "국내산", storage_state: "냉장", base_price: 0, unit: "kg", stock_quantity: 0, is_active: false })
      .select("id")
      .single();

    const { created, withTrace } = await importRows([
      { storageHint: "냉장", partHint: part },
      { storageHint: "냉동", partHint: part },
      { storageHint: null, partHint: part },
    ]);

    expect(created.success, created.error).toBe(true);
    await drain(created.data!.jobId);

    const scans = await scanProducts(withTrace.map((row) => row.traceNo));
    const byTrace = new Map(scans.map((scan) => [scan.trace_no, scan]));

    expect(byTrace.get(withTrace[0].traceNo)?.product_id).toBe(existing!.id);
    expect(byTrace.get(withTrace[1].traceNo)?.products).toMatchObject({ subcategory: part, storage_state: "냉동" });
    expect(byTrace.get(withTrace[2].traceNo)?.status).toBe("PENDING_MAPPING");
  });

  it("등록되지 않은 부위가 하나라도 있으면 아무 행도 올리지 않고 그 부위를 알려준다", async () => {
    const { created, withTrace } = await importRows([{ storageHint: "냉장", partHint: `없는부위-${world.runId}` }]);

    expect(created.success).toBe(false);
    expect(created.error).toContain(`없는부위-${world.runId}`);
    expect(await scanProducts(withTrace.map((row) => row.traceNo))).toHaveLength(0);
  });
});
