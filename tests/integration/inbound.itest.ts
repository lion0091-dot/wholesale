/**
 * 3. 입고 — 서버 액션 한 겹(권한·입력 검증·정부 API 흐름·상품 자동 결정·중복 스캔·취소·상품 지정) + 실제 DB.
 * DB 함수 레벨은 scripts/db-test-inbound.sql 이 이미 한다. 정부 API(fetchTraceRecord)만 흉내 낸다.
 * 엑셀 대량 입고·명세서 업로드/사전조회(document-actions)는 이 파일 범위 밖.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World, type WorldProduct } from "./harness";

vi.mock("@/lib/livestock/mtrace-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/livestock/mtrace-client")>();

  return { ...original, fetchTraceRecord: vi.fn(), isMtraceConfigured: vi.fn() };
});

import { fetchTraceRecord, isMtraceConfigured, MtraceNotConfiguredError, type MtraceRecord } from "@/lib/livestock/mtrace-client";
import {
  recordScanAction,
  resolveMappingAction,
  voidScanAction,
  type ScanResult,
} from "@/app/dashboard/inbound/actions";

const fetchTraceMock = vi.mocked(fetchTraceRecord);
const configuredMock = vi.mocked(isMtraceConfigured);

let world: World;

function apiRecord(traceNo: string, overrides: Partial<MtraceRecord> = {}): MtraceRecord {
  return {
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
    ...overrides,
  };
}

async function scanRow(traceNo: string) {
  const { data } = await adminClient()
    .from("inbound_scans")
    .select("id, status, product_id, weight, remaining_weight, purchase_amount, gtin")
    .eq("wholesaler_id", world.wholesalerA)
    .eq("trace_no", traceNo)
    .order("created_at", { ascending: false });

  return data ?? [];
}

async function stockOf(productId: string): Promise<number> {
  const { data } = await adminClient().from("products").select("stock_quantity").eq("id", productId).single();

  return Number(data?.stock_quantity);
}

async function cachedTrace(traceNo: string) {
  const { data } = await adminClient().from("master_livestock").select("trace_no, part_name").eq("trace_no", traceNo).maybeSingle();

  return data;
}

async function exceptionReasons(scanId: string): Promise<string[]> {
  const { data } = await adminClient().from("livestock_exception_log").select("reason").eq("inbound_scan_id", scanId);

  return (data ?? []).map((row) => String(row.reason));
}

/** 입고용 상품 — 재고 0에서 시작해 원장 합계만 남게 한다(수동 재고는 원장 첫 편입 때 OPENING_BALANCE로 옮겨진다). */
function newProduct(overrides: Record<string, unknown> = {}): Promise<WorldProduct> {
  return world.createProduct({ stock_quantity: 0, subcategory: "등심", category: "소", ...overrides });
}

function scanData(result: Awaited<ReturnType<typeof recordScanAction>>): ScanResult {
  expect(result.success).toBe(true);

  return result.data as ScanResult;
}

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

beforeEach(async () => {
  fetchTraceMock.mockReset();
  configuredMock.mockReset();
  configuredMock.mockReturnValue(true);
  await actAs(world.users.ownerA);
});

describe("recordScanAction — 권한·입력 검증", () => {
  it("비로그인·고객 계정은 입고할 수 없다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await actAs(null);
    const anonymous = await recordScanAction({ traceNo, weight: 5, scanType: "MANUAL", productId: product.id });

    await actAs(world.users.retailerR);
    const retailer = await recordScanAction({ traceNo, weight: 5, scanType: "MANUAL", productId: product.id });

    expect(anonymous.success).toBe(false);
    expect(retailer.success).toBe(false);
    expect(await scanRow(traceNo)).toHaveLength(0);
  });

  it("직원(staff)은 스캔은 되지만 매입단가를 넣으면 정부 API를 부르기 전에 거부된다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await actAs(world.users.staffA);
    const denied = await recordScanAction({ traceNo, weight: 5, scanType: "MANUAL", productId: product.id, purchaseUnitPrice: 10000 });

    expect(denied.success).toBe(false);
    expect(denied.error).toContain("매입단가는 관리자");
    expect(fetchTraceMock).not.toHaveBeenCalled();
    expect(await scanRow(traceNo)).toHaveLength(0);

    await world.seedTrace(traceNo);
    const allowed = await recordScanAction({ traceNo, weight: 5, scanType: "MANUAL", productId: product.id });

    expect(scanData(allowed).status).toBe("NORMAL");
  });

  it("매니저는 매입단가를 넣을 수 있고 매입금액은 실중량 × 단가로 계산된다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    await actAs(world.users.managerA);
    const data = scanData(
      await recordScanAction({ traceNo, weight: 5.5, scanType: "MANUAL", productId: product.id, purchaseUnitPrice: 10000 })
    );

    expect(data.purchaseUnitPrice).toBe(10000);
    expect(data.purchaseAmount).toBe(55000);
  });

  it("이력번호 형식이 틀리면 거부하고 아무것도 기록하지 않는다", async () => {
    const result = await recordScanAction({ traceNo: "abc", weight: 5, scanType: "MANUAL" });

    expect(result).toEqual({ success: false, error: "이력번호 형식이 올바르지 않습니다. 다시 스캔해주세요." });
  });

  it("자체 세트번호는 입고 화면에서 거부하고 세트 상품 화면으로 안내한다", async () => {
    const result = await recordScanAction({ traceNo: "SET-260924-001", weight: 5, scanType: "MANUAL" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("세트 박스 번호");
    expect(fetchTraceMock).not.toHaveBeenCalled();
  });

  it("중량이 0·음수·숫자가 아니면 거부한다", async () => {
    const traceNo = world.newTraceNo();

    for (const weight of [0, -1, Number.NaN]) {
      const result = await recordScanAction({ traceNo, weight, scanType: "MANUAL" });

      expect(result).toEqual({ success: false, error: "중량을 입력해주세요." });
    }

    expect(await scanRow(traceNo)).toHaveLength(0);
  });
});

describe("recordScanAction — 정부 API 흐름", () => {
  it("캐시에 이력이 있으면 정부 API를 부르지 않고 재고가 늘어난다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const data = scanData(await recordScanAction({ traceNo, weight: 8.2, scanType: "BARCODE_SCAN", productId: product.id }));

    expect(fetchTraceMock).not.toHaveBeenCalled();
    expect(data).toMatchObject({ status: "NORMAL", masterFound: true, productId: product.id, failReason: null });
    expect(await stockOf(product.id)).toBeCloseTo(8.2);

    const [row] = await scanRow(traceNo);

    expect(Number(row.remaining_weight)).toBeCloseTo(8.2);
  });

  it("캐시에 없으면 정부 API를 한 번 부르고 결과를 공용 캐시에 적재한다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    fetchTraceMock.mockResolvedValue(apiRecord(traceNo));
    const data = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN", productId: product.id }));

    expect(fetchTraceMock).toHaveBeenCalledTimes(1);
    expect(fetchTraceMock).toHaveBeenCalledWith(traceNo);
    expect(data).toMatchObject({ status: "NORMAL", masterFound: true, partName: "등심", grade: "1++" });
    expect(await cachedTrace(traceNo)).toMatchObject({ part_name: "등심" });
  });

  it("정부 API가 '없는 번호'라고 하면 입고는 예외(NOT_FOUND)로 기록되고 재고는 늘지 않는다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    fetchTraceMock.mockResolvedValue(null);
    const data = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN", productId: product.id }));

    expect(data).toMatchObject({ status: "EXCEPTION", masterFound: false, failReason: "NOT_FOUND", failIsNotConfigured: false });
    expect(await stockOf(product.id)).toBe(0);
    expect(await exceptionReasons(data.scanId)).toEqual(["NOT_FOUND"]);
  });

  it("정부 API 오류(타임아웃/5xx)여도 입고를 막지 않고 API_ERROR 예외로 남기며 사유를 함께 돌려준다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchTraceMock.mockRejectedValue(new Error("HTTP 503 Service Unavailable"));
    const data = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN", productId: product.id }));

    expect(data).toMatchObject({ status: "EXCEPTION", failReason: "API_ERROR", failIsNotConfigured: false });
    expect(data.failDetail).toContain("503");
    expect(await stockOf(product.id)).toBe(0);
  });

  it("이 번호가 필요로 하는 기관의 키가 없으면 '재시도해도 안 됨(설정 문제)'으로 구분된다", async () => {
    const traceNo = world.newTraceNo();

    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchTraceMock.mockRejectedValue(new MtraceNotConfiguredError("닭 이력 인증키 없음"));
    const data = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN" }));

    expect(data).toMatchObject({ status: "EXCEPTION", failReason: "API_ERROR", failIsNotConfigured: true });
  });

  it("정부 API 인증키가 아예 없으면 호출 없이 예외로 기록하고 설정 문제로 안내한다", async () => {
    const traceNo = world.newTraceNo();

    configuredMock.mockReturnValue(false);
    const data = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN" }));

    expect(fetchTraceMock).not.toHaveBeenCalled();
    expect(data).toMatchObject({ status: "EXCEPTION", failReason: "API_ERROR", failIsNotConfigured: true });
    expect(data.failDetail).toContain("인증키");
  });

  it("표기중량과 실중량 차이가 ±2%를 넘으면 varianceExceeded 로 알린다(입고는 그대로)", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const data = scanData(
      await recordScanAction({ traceNo, weight: 10.5, labeledWeight: 10, scanType: "BARCODE_SCAN", productId: product.id })
    );

    expect(data).toMatchObject({ status: "NORMAL", varianceExceeded: true });
    expect(data.weightVariance).toBeCloseTo(0.5);
    expect(await stockOf(product.id)).toBeCloseTo(10.5);
  });
});

describe("recordScanAction — 중복 스캔", () => {
  it("같은 번호·같은 중량을 바로 또 찍으면 저장하지 않고 확인을 요청하며, 확인하면 강행된다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    scanData(await recordScanAction({ traceNo, weight: 5, scanType: "BARCODE_SCAN", productId: product.id }));

    const second = await recordScanAction({ traceNo, weight: 5, scanType: "BARCODE_SCAN", productId: product.id });

    expect(second.success).toBe(true);
    expect(second.data).toEqual({ duplicate: { lastScannedAt: expect.stringMatching(/^\d{2}:\d{2}$/) } });
    expect(await scanRow(traceNo)).toHaveLength(1);
    expect(await stockOf(product.id)).toBe(5);

    const confirmed = await recordScanAction({
      traceNo,
      weight: 5,
      scanType: "BARCODE_SCAN",
      productId: product.id,
      confirmDuplicate: true,
    });

    expect(scanData(confirmed).status).toBe("NORMAL");
    expect(await scanRow(traceNo)).toHaveLength(2);
    expect(await stockOf(product.id)).toBe(10);
  });
});

describe("recordScanAction — 상품 자동 결정", () => {
  it("명세서에 올려둔 이력번호는 상품을 고르지 않아도 그 줄의 상품으로 확정된다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    await world.createDocumentLine({ traceNo, product });
    const data = scanData(await recordScanAction({ traceNo, weight: 7, scanType: "BARCODE_SCAN" }));

    expect(data).toMatchObject({ status: "NORMAL", productId: product.id });
    expect(await stockOf(product.id)).toBe(7);
  });

  it("두 칸 서식(묶음번호+개체번호) 명세서는 박스 바코드가 묶음번호로 찍혀도 그 줄의 상품으로 확정된다", async () => {
    const product = await newProduct();
    const memberTraceNo = world.newTraceNo();
    const lotNo = `L${String(Date.now()).padStart(14, "0").slice(-14)}`;

    await world.seedTrace(lotNo, { traceKind: "group" });
    await world.createDocumentLine({ traceNo: memberTraceNo, lotNo, product });
    const data = scanData(await recordScanAction({ traceNo: lotNo, weight: 7, scanType: "BARCODE_SCAN" }));

    expect(data).toMatchObject({ status: "NORMAL", productId: product.id });
  });

  it("명세서는 묶음번호, 박스는 그 안의 개체번호 — 로트 구성원 목록으로 이어 그 줄의 상품으로 확정된다", async () => {
    const product = await newProduct();
    const member = world.newTraceNo();
    const other = world.newTraceNo();
    const lotNo = `L${String(Date.now() + 2).padStart(14, "0").slice(-14)}`;

    // 정부 로트 응답 구조 그대로 — 개체마다 <item>이 반복되고 pigNo/cattleNo가 붙는다.
    await world.seedTrace(lotNo, {
      traceKind: "group",
      rawPayload: { response: { body: { items: { item: [{ cattleNo: member }, { cattleNo: other }] } } } },
    });
    await world.seedTrace(member);
    await world.createDocumentLine({ traceNo: lotNo, product });

    const data = scanData(await recordScanAction({ traceNo: member, weight: 7, scanType: "BARCODE_SCAN" }));

    expect(data).toMatchObject({ status: "NORMAL", productId: product.id });
  });

  it("구성원이 아닌 개체번호는 그 로트 줄에 붙지 않는다", async () => {
    const product = await newProduct();
    const stranger = world.newTraceNo();
    const lotNo = `L${String(Date.now() + 3).padStart(14, "0").slice(-14)}`;

    await world.seedTrace(lotNo, {
      traceKind: "group",
      rawPayload: { response: { body: { items: { item: [{ cattleNo: world.newTraceNo() }] } } } },
    });
    await world.seedTrace(stranger, { part: null, speciesGroup: null });
    await world.createDocumentLine({ traceNo: lotNo, product });

    const data = scanData(await recordScanAction({ traceNo: stranger, weight: 7, scanType: "BARCODE_SCAN" }));

    expect(data.status).toBe("PENDING_MAPPING");
    expect(data.productId).toBeNull();
  });

  it("반대 방향 — 명세서는 개체번호, 박스는 그 개체가 든 묶음번호로 찍혀도 이어진다", async () => {
    const product = await newProduct();
    const member = world.newTraceNo();
    const lotNo = `L${String(Date.now() + 4).padStart(14, "0").slice(-14)}`;

    await world.seedTrace(lotNo, {
      traceKind: "group",
      rawPayload: { response: { body: { items: { item: [{ pigNo: member }] } } } },
    });
    await world.createDocumentLine({ traceNo: member, product });

    const data = scanData(await recordScanAction({ traceNo: lotNo, weight: 7, scanType: "BARCODE_SCAN" }));

    expect(data).toMatchObject({ status: "NORMAL", productId: product.id });
  });

  it("대기 목록 — 로트 줄은 구성원 개체번호가 한 번이라도 찍히면 '만난 것'으로 빠진다", async () => {
    const admin = adminClient();
    const product = await newProduct();
    const member = world.newTraceNo();
    const lotNo = `L${String(Date.now() + 5).padStart(14, "0").slice(-14)}`;
    const untouchedLot = `L${String(Date.now() + 6).padStart(14, "0").slice(-14)}`;

    await world.seedTrace(lotNo, {
      traceKind: "group",
      rawPayload: { response: { body: { items: { item: [{ pigNo: member }] } } } },
    });
    await world.seedTrace(untouchedLot, { traceKind: "group", rawPayload: {} });
    await world.seedTrace(member);
    await world.createDocumentLine({ traceNo: lotNo, product });
    await world.createDocumentLine({ traceNo: untouchedLot, product });

    // 화면(page.tsx)과 같은 경로 — 로그인한 공급사 세션으로 부른다(업체 접근 권한 검사가 있다).
    const actor = getActorClient();
    const before = await actor.rpc("list_awaiting_document_line_ids", { p_wholesaler_id: world.wholesalerA });
    const awaitingBefore = ((before.data ?? []) as string[]).length;

    await recordScanAction({ traceNo: member, weight: 7, scanType: "BARCODE_SCAN" });

    const { data: lines } = await admin
      .from("inbound_document_lines")
      .select("id, trace_no")
      .in("trace_no", [lotNo, untouchedLot]);
    const after = await actor.rpc("list_awaiting_document_line_ids", { p_wholesaler_id: world.wholesalerA });
    const awaitingAfter = new Set(((after.data ?? []) as string[]).map(String));
    const lotLine = (lines ?? []).find((row) => row.trace_no === lotNo);
    const untouchedLine = (lines ?? []).find((row) => row.trace_no === untouchedLot);

    expect(awaitingBefore).toBeGreaterThanOrEqual(2);
    expect(awaitingAfter.has(String(lotLine?.id))).toBe(false);
    expect(awaitingAfter.has(String(untouchedLine?.id))).toBe(true);
  });

  it("대기 목록 — 취소(VOIDED)된 박스는 안 온 것과 같아서 그 줄은 계속 대기로 남는다", async () => {
    const admin = adminClient();
    const product = await newProduct();
    const traceNo = world.newTraceNo();
    const { lineId } = await world.createDocumentLine({ traceNo, product });
    const actor = getActorClient();
    const awaiting = async () => {
      const { data } = await actor.rpc("list_awaiting_document_line_ids", { p_wholesaler_id: world.wholesalerA });

      return new Set(((data ?? []) as string[]).map(String));
    };
    const { data: scan, error } = await admin
      .from("inbound_scans")
      .insert({
        wholesaler_id: world.wholesalerA,
        trace_no: traceNo,
        product_id: null,
        weight: 5,
        scan_type: "MANUAL",
        status: "NORMAL",
        remaining_weight: 0,
      })
      .select("id")
      .single();

    expect(error).toBeNull();
    expect((await awaiting()).has(lineId)).toBe(false);

    await admin.from("inbound_scans").update({ status: "VOIDED" }).eq("id", String(scan?.id));

    expect((await awaiting()).has(lineId)).toBe(true);
  });

  it("같은 묶음번호에 서로 다른 상품이 걸린 줄이 둘이면 자동으로 고르지 않는다(되묻는다)", async () => {
    const first = await newProduct();
    const second = await newProduct();
    const lotNo = `L${String(Date.now() + 1).padStart(14, "0").slice(-14)}`;

    await world.seedTrace(lotNo, { traceKind: "group", part: null, speciesGroup: null });
    await world.createDocumentLine({ traceNo: world.newTraceNo(), lotNo, product: first });
    await world.createDocumentLine({ traceNo: world.newTraceNo(), lotNo, product: second });
    const data = scanData(await recordScanAction({ traceNo: lotNo, weight: 7, scanType: "BARCODE_SCAN" }));

    expect(data.status).toBe("PENDING_MAPPING");
    expect(data.productId).toBeNull();
  });

  it("취소된 명세서의 줄은 무시한다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, speciesGroup: null });
    await world.createDocumentLine({ traceNo, product, status: "DISCARDED" });
    const data = scanData(await recordScanAction({ traceNo, weight: 7, scanType: "BARCODE_SCAN" }));

    expect(data.status).toBe("PENDING_MAPPING");
    expect(data.productId).toBeNull();
    expect(await stockOf(product.id)).toBe(0);
  });

  it("처음 취급하는 고기는 이력의 축종·부위·등급으로 상품이 자동 생성되고, 같은 부위는 다시 만들지 않는다", async () => {
    const admin = adminClient();
    const first = world.newTraceNo();
    const second = world.newTraceNo();

    // 이 공급사(A)에 아직 없는 부위 — 앞 테스트들의 상품과 겹치지 않게 '안심'
    await world.seedTrace(first, { part: "안심", grade: "1+" });
    await world.seedTrace(second, { part: "안심", grade: "1+" });

    const created = scanData(await recordScanAction({ traceNo: first, weight: 4, scanType: "BARCODE_SCAN" }));

    expect(created.status).toBe("NORMAL");
    expect(created.autoCreated).toMatchObject({ needsPrice: true });
    expect(created.productId).not.toBeNull();

    const again = scanData(await recordScanAction({ traceNo: second, weight: 3, scanType: "BARCODE_SCAN" }));

    expect(again.status).toBe("NORMAL");
    expect(again.productId).toBe(created.productId);
    expect(again.autoCreated).toBeNull();

    const { data: products } = await admin
      .from("products")
      .select("id, category, subcategory, stock_quantity")
      .eq("wholesaler_id", world.wholesalerA)
      .eq("subcategory", "안심");

    expect(products).toHaveLength(1);
    expect(products![0]).toMatchObject({ category: "소" });
    expect(Number(products![0].stock_quantity)).toBe(7);
  });

  it("이력에 부위가 없어도 축종만 알면 '(부위 미지정)' 상품으로 자동 생성된다", async () => {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, grade: "2등급" });
    const data = scanData(await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN" }));

    expect(data.status).toBe("NORMAL");
    expect(data.autoCreated?.productName).toContain("(부위 미지정)");
    expect(data.productId).not.toBeNull();
    expect(await stockOf(data.productId!)).toBe(4);
  });

  it("축종조차 모르는 이력은 상품을 만들 수 없어 상품 확인 대기(PENDING_MAPPING)로 두고 아무 상품도 만들지 않는다", async () => {
    const traceNo = world.newTraceNo();
    const countProducts = async () =>
      (await adminClient().from("products").select("id", { count: "exact", head: true }).eq("wholesaler_id", world.wholesalerA)).count;

    await world.seedTrace(traceNo, { part: null, speciesGroup: null });
    const before = await countProducts();
    const data = scanData(await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN" }));

    expect(data).toMatchObject({ status: "PENDING_MAPPING", productId: null, autoCreated: null });
    expect(await countProducts()).toBe(before);
  });

  it("상품코드(GTIN)가 있는 박스를 사람이 상품에 지정하면 그 코드를 기억해 다음 박스는 자동 확정된다", async () => {
    const product = await newProduct();
    const gtin = "08801234500017";
    const first = world.newTraceNo();
    const second = world.newTraceNo();

    await world.seedTrace(first, { part: null, speciesGroup: null });
    await world.seedTrace(second, { part: null, speciesGroup: null });

    const pending = scanData(await recordScanAction({ traceNo: first, weight: 4, scanType: "BARCODE_SCAN", gtin }));

    expect(pending.status).toBe("PENDING_MAPPING");
    expect((await scanRow(first))[0].gtin).toBe(gtin);

    const resolved = await resolveMappingAction(pending.scanId, product.id);

    expect(resolved.success).toBe(true);

    const next = scanData(await recordScanAction({ traceNo: second, weight: 5, scanType: "BARCODE_SCAN", gtin }));

    expect(next).toMatchObject({ status: "NORMAL", productId: product.id });
    expect(await stockOf(product.id)).toBe(9);
  });

  it("바코드 상품코드 학습과 명세서가 다른 상품을 가리키면 바코드를 따르되 충돌을 알린다", async () => {
    const learned = await newProduct();
    const documented = await newProduct();
    const gtin = "08801234500024";
    const first = world.newTraceNo();
    const second = world.newTraceNo();

    await world.seedTrace(first, { part: null, speciesGroup: null });
    await world.seedTrace(second, { part: null, speciesGroup: null });

    const pending = scanData(await recordScanAction({ traceNo: first, weight: 4, scanType: "BARCODE_SCAN", gtin }));
    await resolveMappingAction(pending.scanId, learned.id);

    await world.createDocumentLine({ traceNo: second, product: documented });
    const data = scanData(await recordScanAction({ traceNo: second, weight: 5, scanType: "BARCODE_SCAN", gtin }));

    expect(data).toMatchObject({
      status: "NORMAL",
      productId: learned.id,
      productConflict: { gtinProductId: learned.id, documentProductId: documented.id },
    });
    expect(await stockOf(documented.id)).toBe(0);
  });

  it("둘이 같은 상품을 가리키면 충돌이 아니다", async () => {
    const product = await newProduct();
    const gtin = "08801234500031";
    const first = world.newTraceNo();
    const second = world.newTraceNo();

    await world.seedTrace(first, { part: null, speciesGroup: null });
    await world.seedTrace(second, { part: null, speciesGroup: null });

    const pending = scanData(await recordScanAction({ traceNo: first, weight: 4, scanType: "BARCODE_SCAN", gtin }));
    await resolveMappingAction(pending.scanId, product.id);
    await world.createDocumentLine({ traceNo: second, product });

    const data = scanData(await recordScanAction({ traceNo: second, weight: 5, scanType: "BARCODE_SCAN", gtin }));

    expect(data.productConflict).toBeNull();
    expect(data.productId).toBe(product.id);
  });
});

describe("relink_pending_scans_to_documents — 스캔 먼저, 명세서 나중", () => {
  it("상품 미확정으로 남아 있던 박스가 명세서 줄의 상품으로 거슬러 확정되고 재고에 들어간다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, speciesGroup: null });
    const pending = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN" }));

    expect(pending.status).toBe("PENDING_MAPPING");
    expect(await stockOf(product.id)).toBe(0);

    // 명세서가 뒤에 올라온다 — 저장 액션이 끝에서 부르는 것과 같은 함수를 직접 부른다.
    await world.createDocumentLine({ traceNo, product });
    const { data: linked, error } = await getActorClient().rpc("relink_pending_scans_to_documents");

    expect(error).toBeNull();
    expect((linked as Array<{ scan_id: string }>).map((row) => row.scan_id)).toContain(pending.scanId);
    expect((await scanRow(traceNo))[0]).toMatchObject({ status: "NORMAL", product_id: product.id });
    expect(await stockOf(product.id)).toBe(6);
  });

  it("이력 조회 실패(EXCEPTION)로 남은 박스도 명세서가 상품을 지목하면 확정된다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    fetchTraceMock.mockResolvedValueOnce(null);
    const failed = scanData(await recordScanAction({ traceNo, weight: 3, scanType: "BARCODE_SCAN" }));

    expect(failed.status).toBe("EXCEPTION");

    await world.createDocumentLine({ traceNo, product });
    const { data: linked } = await getActorClient().rpc("relink_pending_scans_to_documents");

    expect((linked as Array<{ scan_id: string }>).map((row) => row.scan_id)).toContain(failed.scanId);
    expect((await scanRow(traceNo))[0].status).toBe("NORMAL");
    expect(await stockOf(product.id)).toBe(3);
  });

  it("같은 번호에 서로 다른 상품 줄이 둘이면 거슬러 확정하지 않는다(되묻는다)", async () => {
    const first = await newProduct();
    const second = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, speciesGroup: null });
    const pending = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN" }));

    await world.createDocumentLine({ traceNo, product: first });
    await world.createDocumentLine({ traceNo, product: second });
    const { data: linked } = await getActorClient().rpc("relink_pending_scans_to_documents");

    expect((linked as Array<{ scan_id: string }>).map((row) => row.scan_id)).not.toContain(pending.scanId);
    expect((await scanRow(traceNo))[0].status).toBe("PENDING_MAPPING");
  });
});

describe("명세서 줄 ↔ 박스 연결 (118, 대조용 — 재고와 무관)", () => {
  const admin = adminClient();

  async function linkOf(scanId: string) {
    const { data } = await admin.from("inbound_document_line_scans").select("line_id, linked_how").eq("scan_id", scanId).maybeSingle();

    return data;
  }

  async function statusOf(lineId: string) {
    const { data } = await getActorClient().rpc("document_line_match_status", { p_line_id: lineId });

    return (data as Array<{ expected: number; linked: number; status: string }>)[0];
  }

  it("해당 줄이 하나면 찍는 순간 자동으로 붙고 줄은 완료가 된다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const { lineId } = await world.createDocumentLine({ traceNo, product });

    const data = scanData(await recordScanAction({ traceNo, weight: 7, scanType: "BARCODE_SCAN" }));

    expect(await linkOf(data.scanId)).toMatchObject({ line_id: lineId, linked_how: "AUTO" });
    expect(await statusOf(lineId)).toMatchObject({ expected: 1, linked: 1, status: "COMPLETE" });
  });

  it("같은 개체 3박스 — 수량 3이면 세 번째까지 중복 확인 없이 들어가고, 네 번째는 묻는다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const { lineId } = await world.createDocumentLine({ traceNo, product, quantity: 3 });

    // 같은 번호·같은 중량을 연달아 — 명세서가 없었다면 두 번째부터 중복 의심 창이 떴다.
    for (let index = 0; index < 3; index += 1) {
      const result = await recordScanAction({ traceNo, weight: 8, scanType: "BARCODE_SCAN" });

      expect(result.success).toBe(true);
      expect(result.data && "duplicate" in result.data).toBe(false);
    }

    expect(await statusOf(lineId)).toMatchObject({ expected: 3, linked: 3, status: "COMPLETE" });
    expect(await stockOf(product.id)).toBe(24);

    const fourth = await recordScanAction({ traceNo, weight: 8, scanType: "BARCODE_SCAN" });

    expect(fourth.data && "duplicate" in fourth.data).toBe(true);
  });

  it("같은 번호가 서로 다른 상품의 두 줄에 있으면 붙이지 않는다 — 사무실에서 고른다", async () => {
    const first = await newProduct();
    const second = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, speciesGroup: null });
    const { documentId } = await world.createDocumentLine({ traceNo, product: first });
    await world.createDocumentLine({ traceNo, product: second, documentId });

    const data = scanData(await recordScanAction({ traceNo, weight: 5, scanType: "BARCODE_SCAN" }));

    expect(data.status).toBe("PENDING_MAPPING");
    expect(await linkOf(data.scanId)).toBeNull();
  });

  it("여럿이어도 자리가 남은 줄이 하나면 그 줄에 붙는다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const { documentId, lineId: firstLine } = await world.createDocumentLine({ traceNo, product, quantity: 1 });
    const { lineId: secondLine } = await world.createDocumentLine({ traceNo, product, quantity: 1, documentId });

    const a = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN" }));

    // 첫 박스는 두 줄 다 비어 있어 애매 → 안 붙음. 사무실이 첫 줄에 붙였다고 치자.
    expect(await linkOf(a.scanId)).toBeNull();
    const linked = await getActorClient().rpc("link_scan_to_document_line", { p_scan_id: a.scanId, p_line_id: firstLine, p_how: "MANUAL" });
    expect(linked.error).toBeNull();

    // 두 번째 박스는 남은 자리가 둘째 줄 하나뿐 → 자동으로 붙는다. 같은 번호·다른 중량이라 중복 창과는 무관.
    const b = scanData(await recordScanAction({ traceNo, weight: 6.5, scanType: "BARCODE_SCAN" }));

    expect(await linkOf(b.scanId)).toMatchObject({ line_id: secondLine, linked_how: "AUTO" });
  });

  it("박스를 취소하면 연결이 풀리고 줄은 다시 대기가 된다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const { lineId } = await world.createDocumentLine({ traceNo, product });
    const data = scanData(await recordScanAction({ traceNo, weight: 7, scanType: "BARCODE_SCAN" }));

    expect(await statusOf(lineId)).toMatchObject({ status: "COMPLETE" });
    await voidScanAction(data.scanId, "오입력");

    expect(await linkOf(data.scanId)).toBeNull();
    expect(await statusOf(lineId)).toMatchObject({ linked: 0, status: "AWAITING" });
  });

  it("마감 — 미입고 줄이 남아 있으면 사유 없이는 못 닫고, 사유를 적으면 닫히며 되열 수 있다", async () => {
    const product = await newProduct();
    const actor = getActorClient();
    const { documentId } = await world.createDocumentLine({ traceNo: world.newTraceNo(), product });

    const refused = await actor.rpc("close_inbound_document", { p_document_id: documentId, p_note: null });

    expect(refused.error?.message).toContain("CLOSE_NOTE_REQUIRED:1");

    const closed = await actor.rpc("close_inbound_document", { p_document_id: documentId, p_note: "공급처 결품 통보" });

    expect(closed.error).toBeNull();

    const { data: doc } = await admin.from("inbound_documents").select("status, note").eq("id", documentId).single();

    expect(doc?.status).toBe("CLOSED");
    expect(doc?.note).toContain("공급처 결품 통보");

    // 마감된 서류엔 못 붙인다.
    const traceNo = world.newTraceNo();
    await world.seedTrace(traceNo);
    const scan = scanData(await recordScanAction({ traceNo, weight: 3, scanType: "BARCODE_SCAN" }));
    const { data: lines } = await admin.from("inbound_document_lines").select("id").eq("document_id", documentId);
    const blocked = await actor.rpc("link_scan_to_document_line", { p_scan_id: scan.scanId, p_line_id: lines?.[0]?.id, p_how: "MANUAL" });

    expect(blocked.error?.message).toContain("DOCUMENT_NOT_PENDING");

    const reopened = await actor.rpc("reopen_inbound_document", { p_document_id: documentId });

    expect(reopened.error).toBeNull();
  });

  it("명세서를 나중에 올려도(거슬러 확정) 이미 찍힌 박스가 줄에 붙는다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const data = scanData(await recordScanAction({ traceNo, weight: 7, scanType: "BARCODE_SCAN", productId: product.id }));

    expect(await linkOf(data.scanId)).toBeNull();

    const { lineId } = await world.createDocumentLine({ traceNo, product });
    await getActorClient().rpc("relink_pending_scans_to_documents");

    expect(await linkOf(data.scanId)).toMatchObject({ line_id: lineId, linked_how: "AUTO" });
  });
});

describe("voidScanAction", () => {
  it("입고를 취소하면 재고가 원복되고, 다시 취소하면 '이미 취소' 안내가 나온다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const data = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN", productId: product.id }));

    expect(await stockOf(product.id)).toBe(6);

    expect(await voidScanAction(data.scanId, " 오입력 ")).toEqual({ success: true });
    expect(await stockOf(product.id)).toBe(0);
    expect((await scanRow(traceNo))[0].status).toBe("VOIDED");

    expect(await voidScanAction(data.scanId)).toEqual({ success: false, error: "이미 취소된 입고입니다." });
    expect(await stockOf(product.id)).toBe(0);
  });

  it("다른 공급사 사장은 남의 입고를 취소할 수 없다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const data = scanData(await recordScanAction({ traceNo, weight: 6, scanType: "BARCODE_SCAN", productId: product.id }));

    await actAs(world.users.ownerB);
    const result = await voidScanAction(data.scanId);

    expect(result.success).toBe(false);
    expect(await stockOf(product.id)).toBe(6);
    expect((await scanRow(traceNo))[0].status).toBe("NORMAL");
  });
});

describe("resolveMappingAction", () => {
  async function pendingScan() {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, speciesGroup: null });

    return scanData(await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN" }));
  }

  it("상품을 지정하면 재고로 확정되고, 이미 처리된 입고를 다시 지정하면 안내 문구가 나온다", async () => {
    const product = await newProduct();
    const pending = await pendingScan();

    const result = await resolveMappingAction(pending.scanId, product.id);

    expect(result.success).toBe(true);
    expect(await stockOf(product.id)).toBe(4);

    expect(await resolveMappingAction(pending.scanId, product.id)).toEqual({
      success: false,
      error: "이미 처리된 입고입니다. 새로고침 후 확인해주세요.",
    });
    expect(await stockOf(product.id)).toBe(4);
  });

  it("이력의 부위와 상품 부위가 다르면 막지 않고 partMismatch 로 경고한다", async () => {
    const product = await newProduct({ subcategory: "목살", category: "돼지" });
    const traceNo = world.newTraceNo();

    // 축종을 몰라 자동 생성이 안 되는(그래서 대기로 남는) 이력 — 부위(등심)는 알고 있다.
    await world.seedTrace(traceNo, { part: "등심", speciesGroup: null });
    const pending = scanData(await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN" }));

    expect(pending.status).toBe("PENDING_MAPPING");

    const result = await resolveMappingAction(pending.scanId, product.id);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ partMismatch: true, tracePart: "등심" });
    expect(await stockOf(product.id)).toBe(4);
  });

  it("다른 공급사의 상품을 지정하려 하면 '상품을 찾을 수 없다'", async () => {
    const pending = await pendingScan();
    const { data: foreign } = await adminClient()
      .from("products")
      .insert({
        wholesaler_id: world.wholesalerB,
        name: `B사상품-${world.runId}`,
        category: "소",
        subcategory: "등심",
        origin: "국내산",
        base_price: 1000,
        unit: "kg",
        stock_quantity: 0,
        is_active: true,
      })
      .select("id")
      .single();

    const result = await resolveMappingAction(pending.scanId, foreign!.id as string);

    expect(result).toEqual({ success: false, error: "선택한 상품을 찾을 수 없습니다." });
  });

  it("다른 공급사 사장은 남의 대기 입고를 확정할 수 없다", async () => {
    const product = await newProduct();
    const pending = await pendingScan();

    await actAs(world.users.ownerB);
    const result = await resolveMappingAction(pending.scanId, product.id);

    expect(result.success).toBe(false);
    expect(await stockOf(product.id)).toBe(0);
  });
});

describe("소 상품 자동 생성 — 정체성 키(축종+부위+등급+원산지)와 명세서 기반 등급 채움", () => {
  async function productOf(productId: string) {
    const { data } = await adminClient().from("products").select("name, category, subcategory, grade, origin").eq("id", productId).single();

    return data as { name: string; category: string; subcategory: string | null; grade: string | null; origin: string };
  }

  it("상품명은 '부위 등급'으로 만들어진다(축종은 화면 태그가 붙인다)", async () => {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: "채끝", grade: "1+" });
    const data = scanData(await recordScanAction({ traceNo, weight: 3, scanType: "BARCODE_SCAN" }));

    expect(data.autoCreated?.productName).toBe("채끝 1+");
    expect(await productOf(data.productId!)).toMatchObject({ name: "채끝 1+", category: "소", subcategory: "채끝", grade: "1+", origin: "국내산" });
  });

  it("부위·등급이 같아도 원산지가 다르면(국내산 ↔ 수입산) 다른 상품으로 만든다", async () => {
    const domestic = world.newTraceNo();
    const imported = world.newTraceNo();

    await world.seedTrace(domestic, { part: "갈비", grade: "1++" });
    await world.seedTrace(imported, { part: "갈비", grade: "1++", traceKind: "imported", originCountry: "미국산" });

    const first = scanData(await recordScanAction({ traceNo: domestic, weight: 3, scanType: "BARCODE_SCAN" }));
    const second = scanData(await recordScanAction({ traceNo: imported, weight: 3, scanType: "BARCODE_SCAN" }));

    expect(first.productId).not.toBe(second.productId);
    expect((await productOf(first.productId!)).origin).toBe("국내산");
    expect((await productOf(second.productId!)).origin).toBe("미국산");
  });

  it("이력에 등급이 없으면 명세서 줄의 등급·부위로 채운다(기반은 명세서)", async () => {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, grade: null });
    await world.createDocumentLine({ traceNo, partName: "양지", grade: "1" });
    const data = scanData(await recordScanAction({ traceNo, weight: 3, scanType: "BARCODE_SCAN" }));

    expect(data.status).toBe("NORMAL");
    expect(await productOf(data.productId!)).toMatchObject({ name: "양지 1", subcategory: "양지", grade: "1" });
  });

  it("이력이 등급을 주면 명세서 등급과 달라도 이력이 우선이다(조회는 사실, 명세서는 빈칸만 메운다)", async () => {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, grade: "1++" });
    await world.createDocumentLine({ traceNo, partName: "목심", grade: "2" });
    const data = scanData(await recordScanAction({ traceNo, weight: 3, scanType: "BARCODE_SCAN" }));

    expect(await productOf(data.productId!)).toMatchObject({ name: "목심 1++", grade: "1++" });
  });

  it("명세서 줄이 여러 등급을 말하면(하나로 좁혀지지 않으면) 등급을 비워두고 '(부위 미지정)' 규칙은 그대로다", async () => {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: null, grade: null });
    await world.createDocumentLine({ traceNo, partName: "설도", grade: "1" });
    await world.createDocumentLine({ traceNo, partName: "설도", grade: "2" });
    const data = scanData(await recordScanAction({ traceNo, weight: 3, scanType: "BARCODE_SCAN" }));

    expect(await productOf(data.productId!)).toMatchObject({ name: "설도", subcategory: "설도", grade: null });
  });
});

describe("소 외 축종 자동 생성 — 정체성 키 = 이력번호 출처(파싱) + 명세서 부위", () => {
  async function productOf(productId: string) {
    const { data } = await adminClient().from("products").select("name, category, subcategory, trace_key").eq("id", productId).single();

    return data as { name: string; category: string; subcategory: string | null; trace_key: string | null };
  }

  const pork = (prefix: string) => world.newTraceNo(prefix);

  async function scanPork(traceNo: string, part: string | null) {
    await world.seedTrace(traceNo, { speciesGroup: "돼지", part: null, grade: null });

    if (part) {
      await world.createDocumentLine({ traceNo, partName: part });
    }

    return scanData(await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN" }));
  }

  it("돼지: 같은 농장(앞 7자리) + 같은 명세서 부위면 같은 상품 — 일련번호가 달라도 새로 만들지 않는다", async () => {
    const first = await scanPork(pork("1400771"), "삼겹살");
    const second = await scanPork(pork("1400771"), "삼겹살");

    expect(second.productId).toBe(first.productId);
    expect(first.autoCreated).not.toBeNull();
    expect(second.autoCreated).toBeNull();

    const product = await productOf(first.productId!);

    expect(product).toMatchObject({ category: "돼지", subcategory: "삼겹살", trace_key: "돼지:400771", name: "삼겹살 (농장 400771)" });
  });

  it("돼지: 같은 농장이어도 부위가 다르면 다른 상품, 부위가 같아도 농장이 다르면 다른 상품", async () => {
    const base = await scanPork(pork("1400772"), "삼겹살");
    const otherPart = await scanPork(pork("1400772"), "목살");
    const otherFarm = await scanPork(pork("1400773"), "삼겹살");

    expect(new Set([base.productId, otherPart.productId, otherFarm.productId]).size).toBe(3);
    expect((await productOf(otherPart.productId!)).name).toBe("목살 (농장 400772)");
    expect((await productOf(otherFarm.productId!)).trace_key).toBe("돼지:400773");
  });

  it("명세서에 부위가 없으면 '(부위 미지정)' 상품이 출처별로 하나씩 만들어지고 재사용된다", async () => {
    const first = await scanPork(pork("1400774"), null);
    const second = await scanPork(pork("1400774"), null);

    expect(second.productId).toBe(first.productId);
    expect((await productOf(first.productId!)).name).toBe("(농장 400774) (부위 미지정)");
  });

  it("닭·오리: 도축장이 같아도 축종코드가 다르면(2 닭 / 5 오리) 다른 상품이고 이름에 축종이 드러난다", async () => {
    const scanPoultry = async (traceNo: string) => {
      await world.seedTrace(traceNo, { speciesGroup: "닭/오리", part: null, grade: null });
      await world.createDocumentLine({ traceNo, partName: "훈제" });

      return scanData(await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN" }));
    };

    const chicken = await scanPoultry(world.newTraceNo("2777"));
    const duck = await scanPoultry(world.newTraceNo("5777"));
    const duckAgain = await scanPoultry(world.newTraceNo("5777"));

    expect(chicken.productId).not.toBe(duck.productId);
    expect(duckAgain.productId).toBe(duck.productId);
    expect(await productOf(chicken.productId!)).toMatchObject({ trace_key: "닭:777", name: "닭 훈제 (도축장 777)" });
    expect(await productOf(duck.productId!)).toMatchObject({ trace_key: "오리:777", name: "오리 훈제 (도축장 777)" });
  });

  it("키를 뽑을 수 없는 번호(형식 밖 첫 자리)는 예전 방식(축종+부위+등급)으로 찾고 trace_key는 비어 있다", async () => {
    const traceNo = world.newTraceNo("9");

    await world.seedTrace(traceNo, { speciesGroup: "돼지", part: null, grade: null });
    await world.createDocumentLine({ traceNo, partName: "앞다리" });

    const data = scanData(await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN" }));

    expect((await productOf(data.productId!)).trace_key).toBeNull();
  });

  it("같은 출처+부위 상품을 동시에 만들려 해도 상품은 하나만 생기고 두 스캔 모두 그 상품에 붙는다", async () => {
    const a = pork("1400775");
    const b = pork("1400775");

    for (const traceNo of [a, b]) {
      await world.seedTrace(traceNo, { speciesGroup: "돼지", part: null, grade: null });
      await world.createDocumentLine({ traceNo, partName: "갈비" });
    }

    const [first, second] = await Promise.all([
      recordScanAction({ traceNo: a, weight: 4, scanType: "BARCODE_SCAN" }),
      recordScanAction({ traceNo: b, weight: 4, scanType: "BARCODE_SCAN" }),
    ]);
    const productIds = new Set([scanData(first).productId, scanData(second).productId]);

    expect(productIds.size).toBe(1);

    const { count } = await adminClient()
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("wholesaler_id", world.wholesalerA)
      .eq("trace_key", "돼지:400775");

    expect(count).toBe(1);
  });
});
