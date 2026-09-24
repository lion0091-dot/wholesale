/**
 * 3. 입고 — 서버 액션 한 겹(권한·입력 검증·정부 API 흐름·상품 자동 결정·중복 스캔·취소·상품 지정) + 실제 DB.
 * DB 함수 레벨은 scripts/db-test-inbound.sql 이 이미 한다. 정부 API(fetchTraceRecord)만 흉내 낸다.
 * 엑셀 대량 입고·명세서 업로드/사전조회(document-actions)는 이 파일 범위 밖.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";

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
