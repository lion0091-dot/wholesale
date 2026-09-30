/**
 * 성능·부하 가드 — 입고 화면이 대기 박스마다 부르는 전표 후보 함수(마이그레이션 175~177)가 실제 규모에서도 빠른지.
 * 입고 화면은 열 때마다 "상품 확인 필요" 박스(최대 20개)마다 scan_po_candidates·scan_open_po_products를 부르고,
 * 스캔 때마다 autocreate_product_for_scan 안에서 scan_po_candidates가 돈다 — 상품 수천 개·전표 줄 수백 개·받은 박스 수백 개에서 잰다.
 * 최악의 경우: 이력조회가 부위를 안 준 박스는 부위를 비교하지 않으므로(모르는 값) 전표의 같은 축종 줄이 전부 후보가 된다.
 * 상한은 실측보다 넉넉해 CI 편차에는 안 흔들리고 큰 회귀(수 초 단위)는 잡는다. 측정값은 마지막에 표로 찍는다.
 */
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";
import { recordScanAction, type ScanResult } from "@/app/dashboard/inbound/actions";

const PRODUCTS = 5000;
const PO_LINES = 300;
const RECEIVED_BOXES = 600;
const PENDING_SCANS = 20;
const LIMIT_MS = 1500;
const OUT = "C:/Users/PC/AppData/Local/Temp/claude/C--workspace-wholesale/c9307fad-9066-4045-89f5-a8bf7b66675f/scratchpad/perf-inbound.txt";

const measurements: Array<[string, number]> = [];

async function timed<T>(label: string, run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  const ms = Math.round(performance.now() - started);

  measurements.push([label, ms]);

  return { value, ms };
}

async function insertChunks(table: string, rows: Array<Record<string, unknown>>, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await adminClient().from(table).insert(rows.slice(i, i + size));

    expect(error, `${table} 시드`).toBeNull();
  }
}

let world: World;
let supplierId: string;
let pendingScanIds: string[] = [];

beforeAll(async () => {
  world = await seedWorld();
  const admin = adminClient();

  const supplier = await admin.from("suppliers").insert({ wholesaler_id: world.wholesalerA, name: `성능거래처-${world.runId}` }).select("id").single();

  supplierId = supplier.data!.id as string;

  // 소 상품 5,000개 — 부위 이름이 전부 달라 정체성 키가 겹치지 않는다. 앞의 300개가 전표에 올라간다.
  const products = Array.from({ length: PRODUCTS }, (_, i) => ({
    wholesaler_id: world.wholesalerA,
    name: `냉장 한우 성능부위${i} 1+`,
    category: "소",
    breed: "한우",
    subcategory: `성능부위${i}`,
    grade: "1+",
    origin: "국내산",
    storage_state: "냉장",
    base_price: 0,
    unit: "kg",
    stock_quantity: 0,
    is_active: false,
  }));

  await insertChunks("products", products);

  const { data: rows } = await admin.from("products").select("id, subcategory").eq("wholesaler_id", world.wholesalerA).like("subcategory", "성능부위%");
  const byPart = new Map((rows ?? []).map((row) => [row.subcategory as string, row.id as string]));
  const onOrder = Array.from({ length: PO_LINES }, (_, i) => byPart.get(`성능부위${i}`)!);

  const order = await admin
    .from("purchase_orders")
    .insert({ wholesaler_id: world.wholesalerA, supplier_id: supplierId, supplier_name: "성능", ordered_on: new Date().toISOString().slice(0, 10), status: "OPEN" })
    .select("id")
    .single();

  await insertChunks(
    "purchase_order_lines",
    onOrder.map((productId, i) => ({
      purchase_order_id: order.data!.id,
      wholesaler_id: world.wholesalerA,
      line_no: i + 1,
      category: "소",
      origin: "국내산",
      quantity: 1000,
      unit: "kg",
      product_id: productId,
    }))
  );

  const { data: lines } = await admin.from("purchase_order_lines").select("id, product_id").eq("purchase_order_id", order.data!.id);

  // 받은 박스 600개 — 전표 줄마다 두 개꼴로 받은 양이 채워져 있다(후보 계산이 줄마다 받은 양을 더한다).
  const boxes = Array.from({ length: RECEIVED_BOXES }, (_, i) => ({
    wholesaler_id: world.wholesalerA,
    trace_no: `88${String(i).padStart(10, "0")}`,
    product_id: lines![i % lines!.length].product_id,
    weight: 10,
    unit: "kg",
    scan_type: "MANUAL",
    status: "NORMAL",
    remaining_weight: 10,
    supplier_id: supplierId,
  }));

  await insertChunks("inbound_scans", boxes);

  const { data: inserted } = await admin.from("inbound_scans").select("id, product_id").eq("wholesaler_id", world.wholesalerA).like("trace_no", "88%");
  const lineByProduct = new Map(lines!.map((line) => [line.product_id as string, line.id as string]));

  await insertChunks(
    "purchase_order_line_scans",
    (inserted ?? []).map((scan) => ({ scan_id: scan.id, line_id: lineByProduct.get(scan.product_id as string)!, wholesaler_id: world.wholesalerA, weight: 10 })),
    200
  );

  // 대기 박스 20개 — 이력조회가 부위를 안 준 소(부위 모름): 전표의 소 줄 300개가 전부 후보가 되는 최악의 경우.
  const traceNos: string[] = [];

  for (let i = 0; i < PENDING_SCANS; i += 1) {
    const traceNo = world.newTraceNo();

    traceNos.push(traceNo);
    await world.seedTrace(traceNo, { part: null, grade: "1+" });
  }

  await insertChunks(
    "inbound_scans",
    traceNos.map((traceNo) => ({
      wholesaler_id: world.wholesalerA,
      trace_no: traceNo,
      product_id: null,
      weight: 5,
      unit: "kg",
      scan_type: "MANUAL",
      status: "PENDING_MAPPING",
      remaining_weight: 0,
      supplier_id: supplierId,
    }))
  );

  const { data: pending } = await admin.from("inbound_scans").select("id").eq("wholesaler_id", world.wholesalerA).eq("status", "PENDING_MAPPING");

  pendingScanIds = (pending ?? []).map((row) => row.id as string);

  await admin.rpc("analyze_tables_for_test").then(
    () => undefined,
    () => undefined
  );
}, 300_000);

afterAll(async () => {
  writeFileSync(OUT, measurements.map(([label, ms]) => `${label}: ${ms}ms`).join("\n"));
  await world?.cleanup();
});

describe("입고 전표 후보 함수 — 상품 5,000·전표 줄 300·받은 박스 600에서의 응답 시간", () => {
  it("scan_po_candidates 한 번(부위 모름 → 후보 300개)이 상한 안에 끝난다", async () => {
    await actAs(world.users.ownerA);

    const { value, ms } = await timed("scan_po_candidates 1회(부위 모름, 후보 300)", async () =>
      getActorClient().rpc("scan_po_candidates", { p_scan_id: pendingScanIds[0] })
    );

    expect(value.error).toBeNull();
    expect((value.data ?? []).length).toBe(PO_LINES);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("scan_open_po_products 한 번이 상한 안에 끝난다", async () => {
    await actAs(world.users.ownerA);

    const { value, ms } = await timed("scan_open_po_products 1회", async () => getActorClient().rpc("scan_open_po_products", { p_scan_id: pendingScanIds[0] }));

    expect(value.error).toBeNull();
    expect((value.data ?? []).length).toBe(PO_LINES);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("입고 화면을 여는 경로: 대기 박스 20개에 후보 함수를 한꺼번에 불러도 상한 안에 끝난다", async () => {
    await actAs(world.users.ownerA);

    const { ms } = await timed("화면 로드: 대기 20개 × scan_po_candidates 동시", async () =>
      Promise.all(pendingScanIds.map((id) => getActorClient().rpc("scan_po_candidates", { p_scan_id: id })))
    );

    expect(ms).toBeLessThan(LIMIT_MS * 3);
  });

  it("스캔 한 번(부위 모름 → 후보 300개라 '확인 필요'로 보관)이 상한 안에 끝난다", async () => {
    await actAs(world.users.ownerA);

    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, grade: "1+" });

    const { value, ms } = await timed("recordScanAction 1회(후보 300 → 보관)", async () =>
      recordScanAction({ traceNo, weight: 5, scanType: "MANUAL", supplierId })
    );

    expect(value.success, value.error).toBe(true);
    expect((value.data as ScanResult).status).toBe("PENDING_MAPPING");
    expect(ms).toBeLessThan(LIMIT_MS * 2);
  });

  it("스캔 한 번(부위 지정 → 후보 1개로 입고)이 상한 안에 끝난다", async () => {
    await actAs(world.users.ownerA);

    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, grade: "1+" });

    const { value, ms } = await timed("recordScanAction 1회(부위 선택 → 입고)", async () =>
      recordScanAction({ traceNo, weight: 5, scanType: "MANUAL", supplierId, partHint: "성능부위7", storageHint: "냉장" })
    );

    expect(value.success, value.error).toBe(true);
    expect((value.data as ScanResult).status).toBe("NORMAL");
    expect(ms).toBeLessThan(LIMIT_MS * 2);
  });
});
