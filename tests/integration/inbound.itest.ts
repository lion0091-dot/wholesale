/**
 * 3. 입고 — 서버 액션 한 겹(권한·입력 검증·정부 API 흐름·상품 자동 결정·중복 스캔·취소·상품 지정) + 실제 DB.
 * DB 함수 레벨은 scripts/db-test-inbound.sql 이 이미 한다. 정부 API(fetchTraceRecord)만 흉내 낸다.
 * 엑셀 대량 입고는 이 파일 범위 밖.
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
  replaceScanTraceNoAction,
  resolveMappingAction,
  retryUnresolvedScansAction,
  voidScanAction,
  type ReplaceTraceResult,
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
    sex: null,
    bms: null,
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

describe("소 상품 자동 생성 — 정체성 키(축종+부위+등급+원산지)", () => {
  async function productOf(productId: string) {
    const { data } = await adminClient().from("products").select("name, category, subcategory, grade, breed, origin").eq("id", productId).single();

    return data as { name: string; category: string; subcategory: string | null; grade: string | null; breed: string | null; origin: string };
  }

  it("상품명은 '품종 부위 등급'으로 만들어지고 품종은 이력조회의 축종 원문에서 온다(축종은 화면 태그가 붙인다)", async () => {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo, { part: "채끝", grade: "1+" });
    const data = scanData(await recordScanAction({ traceNo, weight: 3, scanType: "BARCODE_SCAN" }));

    expect(data.autoCreated?.productName).toBe("한우 채끝 1+");
    expect(await productOf(data.productId!)).toMatchObject({ name: "한우 채끝 1+", category: "소", breed: "한우", subcategory: "채끝", grade: "1+", origin: "국내산" });
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

});

describe("소 외 축종 자동 생성 — 정체성 키 = 돼지 부위+원산지, 닭·오리·계란 원산지(마이그레이션 137)", () => {
  async function productOf(productId: string) {
    const { data } = await adminClient().from("products").select("name, category, subcategory, origin, grade").eq("id", productId).single();

    return data as { name: string; category: string; subcategory: string | null; origin: string | null; grade: string | null };
  }

  // 같은 실행 안의 다른 테스트가 만든 상품과 키가 겹치지 않게 부위 이름을 실행별로 만든다.
  const part = (name: string) => `${name}-${world.runId}`;

  async function scan(
    traceNo: string,
    speciesGroup: string,
    part: string | null,
    seed: { traceKind?: string; originCountry?: string } = {}
  ) {
    await world.seedTrace(traceNo, { speciesGroup, part, grade: null, ...seed });

    return scanData(await recordScanAction({ traceNo, weight: 4, scanType: "BARCODE_SCAN" }));
  }

  it("돼지: 같은 부위+원산지면 농장이 달라도 같은 상품이고 이름은 부위뿐이다", async () => {
    const p = part("삼겹살");
    const first = await scan(world.newTraceNo("1400771"), "돼지", p);
    const second = await scan(world.newTraceNo("1400772"), "돼지", p);

    expect(second.productId).toBe(first.productId);
    expect(first.autoCreated).not.toBeNull();
    expect(second.autoCreated).toBeNull();
    expect(await productOf(first.productId!)).toMatchObject({ category: "돼지", subcategory: p, origin: "국내산", name: p });
  });

  it("돼지: 부위가 다르거나 원산지가 다르면 다른 상품", async () => {
    const base = await scan(world.newTraceNo("1400773"), "돼지", part("목살"));
    const otherPart = await scan(world.newTraceNo("1400773"), "돼지", part("갈비"));
    const imported = await scan(world.newTraceNo("1400773"), "돼지", part("목살"), { traceKind: "imported", originCountry: "스페인산" });

    expect(new Set([base.productId, otherPart.productId, imported.productId]).size).toBe(3);
    expect((await productOf(imported.productId!)).origin).toBe("스페인산");
  });

  it("돼지: 전표에 부위가 없으면 '(부위 미지정)' 상품 하나가 만들어지고 재사용된다", async () => {
    const first = await scan(world.newTraceNo("1400774"), "돼지", null);
    const second = await scan(world.newTraceNo("1400775"), "돼지", null);

    expect(second.productId).toBe(first.productId);
    expect((await productOf(first.productId!)).name).toBe("(부위 미지정)");
  });

  it("닭·오리·계란: 카테고리가 따로고 원산지만 같으면 부위와 상관없이 한 상품이며 이름은 축종이다", async () => {
    const chicken = await scan(world.newTraceNo("2777"), "닭", "정육");
    const chickenAgain = await scan(world.newTraceNo("2778"), "닭", "통닭");
    const duck = await scan(world.newTraceNo("5777"), "오리", "훈제");
    const egg = await scan(world.newTraceNo("3777"), "계란", null);

    expect(chickenAgain.productId).toBe(chicken.productId);
    expect(new Set([chicken.productId, duck.productId, egg.productId]).size).toBe(3);
    expect(await productOf(chicken.productId!)).toMatchObject({ category: "닭", name: "닭", subcategory: null, origin: "국내산" });
    expect(await productOf(duck.productId!)).toMatchObject({ category: "오리", name: "오리", subcategory: null });
    expect(await productOf(egg.productId!)).toMatchObject({ category: "계란", name: "계란" });
  });

  it("상품 관리에서 미리 등록한 상품이 있으면 스캔이 새로 만들지 않고 그 상품에 붙는다", async () => {
    const p = part("항정살");
    const preRegistered = await world.createProduct({ category: "돼지", subcategory: p, origin: "국내산", name: p });
    const pork = await scan(world.newTraceNo("1400776"), "돼지", p);

    expect(pork.productId).toBe(preRegistered.id);
    expect(pork.autoCreated).toBeNull();

    const duck = await world.createProduct({ category: "오리", origin: "호주산", name: "오리" });
    const scannedDuck = await scan(world.newTraceNo("5778"), "오리", null, { traceKind: "imported", originCountry: "호주산" });

    expect(scannedDuck.productId).toBe(duck.id);
  });

  it("원산지는 포함 비교(like) — 이력조회의 '미국'이 미리 등록한 '미국산' 상품에 붙고, 다른 나라는 붙지 않는다", async () => {
    const p = part("등심");
    const registered = await world.createProduct({ category: "돼지", subcategory: p, origin: "미국산", name: p });
    const us = await scan(world.newTraceNo("1400779"), "돼지", p, { traceKind: "imported", originCountry: "미국" });
    const au = await scan(world.newTraceNo("1400779"), "돼지", p, { traceKind: "imported", originCountry: "호주" });

    expect(us.productId).toBe(registered.id);
    expect(au.productId).not.toBe(registered.id);
    expect((await productOf(au.productId!)).origin).toBe("호주산");

    const fr = await scan(world.newTraceNo("1400779"), "돼지", p, { traceKind: "imported", originCountry: "프랑스" });

    expect((await productOf(fr.productId!)).origin).toBe("기타 수입산");
  });

  it("같은 부위+원산지 돼지 상품을 동시에 만들려 해도 상품은 하나만 생기고 두 스캔 모두 그 상품에 붙는다", async () => {
    const p = part("앞다리");
    const a = world.newTraceNo("1400777");
    const b = world.newTraceNo("1400778");

    for (const traceNo of [a, b]) {
      await world.seedTrace(traceNo, { speciesGroup: "돼지", part: p, grade: null });
    }

    const [first, second] = await Promise.all([
      recordScanAction({ traceNo: a, weight: 4, scanType: "BARCODE_SCAN" }),
      recordScanAction({ traceNo: b, weight: 4, scanType: "BARCODE_SCAN" }),
    ]);

    expect(new Set([scanData(first).productId, scanData(second).productId]).size).toBe(1);

    const { count } = await adminClient()
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("wholesaler_id", world.wholesalerA)
      .eq("category", "돼지")
      .eq("subcategory", p);

    expect(count).toBe(1);
  });
});

describe("replaceScanTraceNoAction — 이력조회 실패 박스의 번호를 그 자리에서 바로잡는다", () => {
  function replaced(result: Awaited<ReturnType<typeof replaceScanTraceNoAction>>): ReplaceTraceResult {
    expect(result.success).toBe(true);

    return result.data as ReplaceTraceResult;
  }

  async function failedScan(weight = 5, extra: Record<string, unknown> = {}) {
    const wrong = world.newTraceNo();

    fetchTraceMock.mockResolvedValueOnce(null);
    const failed = scanData(await recordScanAction({ traceNo: wrong, weight, scanType: "BARCODE_SCAN", ...extra }));

    expect(failed.status).toBe("EXCEPTION");

    return { wrong, failed };
  }

  it("맞는 번호로 바꾸면 조회가 되어 상품이 만들어지고 재고에 들어가며, 사람이 넣은 값은 그대로 옮겨진다", async () => {
    const { wrong, failed } = await failedScan(5, { labeledWeight: 5.2 });
    const good = world.newTraceNo();

    await adminClient()
      .from("inbound_scans")
      .update({ storage_location: "A-3 선반", gtin: "08800000000017", best_before: "2099-01-01" })
      .eq("id", failed.scanId);
    const oldRow = (await adminClient().from("inbound_scans").select("created_at, scanned_by").eq("id", failed.scanId).single()).data!;

    fetchTraceMock.mockResolvedValueOnce(apiRecord(good));
    const result = replaced(await replaceScanTraceNoAction(failed.scanId, good));

    expect(result).toMatchObject({ status: "NORMAL", changed: true, traceNo: good });

    const { data: oldScan } = await adminClient().from("inbound_scans").select("status, memo").eq("id", failed.scanId).single();
    const { data: newScan } = await adminClient()
      .from("inbound_scans")
      .select("status, product_id, weight, remaining_weight, labeled_weight, storage_location, gtin, best_before, created_at, scanned_by")
      .eq("id", result.scanId)
      .single();

    expect(oldScan).toMatchObject({ status: "VOIDED" });
    expect(String(oldScan!.memo)).toContain(`${wrong} → ${good}`);
    expect(newScan).toMatchObject({
      status: "NORMAL",
      weight: 5,
      remaining_weight: 5,
      labeled_weight: 5.2,
      storage_location: "A-3 선반",
      gtin: "08800000000017",
      best_before: "2099-01-01",
      created_at: oldRow.created_at,
      scanned_by: oldRow.scanned_by,
    });
    const { data: ledger } = await adminClient().from("stock_ledger").select("qty_delta, event_type").eq("inbound_scan_id", result.scanId);

    expect(ledger).toEqual([{ qty_delta: 5, event_type: "INBOUND" }]);
    expect((await adminClient().from("livestock_exception_log").select("resolved_status").eq("inbound_scan_id", failed.scanId)).data).toEqual([
      { resolved_status: "DISCARDED" },
    ]);
  });

  it("새 번호도 이력에 없으면 그 번호의 '이력 못 찾음' 박스로 바뀐다", async () => {
    const { failed } = await failedScan();
    const stillWrong = world.newTraceNo();

    fetchTraceMock.mockResolvedValueOnce(null);
    const result = replaced(await replaceScanTraceNoAction(failed.scanId, stillWrong));

    expect(result).toMatchObject({ status: "EXCEPTION", changed: true, failReason: "NOT_FOUND", traceNo: stillWrong });
    expect((await scanRow(stillWrong))[0].status).toBe("EXCEPTION");
  });

  it("같은 번호를 다시 조회했는데 여전히 못 찾으면 박스를 갈아치우지 않는다", async () => {
    const { wrong, failed } = await failedScan();

    fetchTraceMock.mockResolvedValueOnce(null);
    const result = replaced(await replaceScanTraceNoAction(failed.scanId, wrong));

    expect(result).toMatchObject({ status: "EXCEPTION", changed: false, scanId: failed.scanId });
    expect((await scanRow(wrong)).map((row) => row.status)).toEqual(["EXCEPTION"]);
  });

  it("같은 번호가 그 사이 이력에 등록됐으면 다시 조회해 상품·재고까지 이어진다", async () => {
    const { wrong, failed } = await failedScan(4);

    fetchTraceMock.mockResolvedValueOnce(apiRecord(wrong));
    const result = replaced(await replaceScanTraceNoAction(failed.scanId, wrong));

    expect(result).toMatchObject({ status: "NORMAL", changed: true });
    expect((await scanRow(wrong)).map((row) => row.status).sort()).toEqual(["NORMAL", "VOIDED"]);
  });

  it("재고에 이미 들어간 박스는 번호를 바꿀 수 없다", async () => {
    const product = await newProduct();
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    const normal = scanData(await recordScanAction({ traceNo, weight: 5, scanType: "BARCODE_SCAN", productId: product.id }));
    const result = await replaceScanTraceNoAction(normal.scanId, world.newTraceNo());

    expect(result.success).toBe(false);
    expect(result.error).toContain("재고에 들어갔");
    expect(await stockOf(product.id)).toBe(5);
  });

  it("형식이 틀린 번호는 조회 전에 거부하고 박스는 그대로다", async () => {
    const { failed } = await failedScan();
    const result = await replaceScanTraceNoAction(failed.scanId, "abc");

    expect(result.success).toBe(false);
    expect(result.error).toContain("이력번호 형식");
    expect((await adminClient().from("inbound_scans").select("status").eq("id", failed.scanId).single()).data).toEqual({ status: "EXCEPTION" });
  });

  it("고친 번호가 이미 같은 무게로 찍힌 박스와 겹치면 확인을 묻고, 옛 박스는 그대로 둔다", async () => {
    const { failed } = await failedScan(5);
    const taken = world.newTraceNo();

    await world.seedTrace(taken);
    scanData(await recordScanAction({ traceNo: taken, weight: 5, scanType: "BARCODE_SCAN", productId: (await newProduct()).id }));

    fetchTraceMock.mockResolvedValueOnce(apiRecord(taken));
    const asked = await replaceScanTraceNoAction(failed.scanId, taken);

    expect(asked.data).toMatchObject({ duplicate: { lastScannedAt: expect.any(String) } });
    expect((await adminClient().from("inbound_scans").select("status").eq("id", failed.scanId).single()).data).toEqual({ status: "EXCEPTION" });

    fetchTraceMock.mockResolvedValueOnce(apiRecord(taken));
    const confirmed = replaced(await replaceScanTraceNoAction(failed.scanId, taken, true));

    expect(confirmed.changed).toBe(true);
  });

  it("다른 업체 계정은 남의 박스 번호를 바꿀 수 없다", async () => {
    const { failed } = await failedScan();

    await actAs(world.users.ownerB);
    const result = await replaceScanTraceNoAction(failed.scanId, world.newTraceNo());

    expect(result.success).toBe(false);
    expect((await adminClient().from("inbound_scans").select("status").eq("id", failed.scanId).single()).data).toEqual({ status: "EXCEPTION" });
  });

});

describe("retryUnresolvedScansAction — 이력조회 실패 박스를 시스템이 알아서 다시 조회한다", () => {
  async function isolateExistingExceptions() {
    await adminClient()
      .from("inbound_scans")
      .update({ lookup_retried_at: new Date().toISOString() })
      .eq("wholesaler_id", world.wholesalerA)
      .eq("status", "EXCEPTION");
  }

  async function failedScanFor(traceNo: string, weight: number) {
    fetchTraceMock.mockResolvedValueOnce(null);
    const failed = scanData(await recordScanAction({ traceNo, weight, scanType: "BARCODE_SCAN" }));

    expect(failed.status).toBe("EXCEPTION");

    return failed;
  }

  it("그 사이 등록된 번호는 상품·재고까지 이어지고, 여전히 못 찾은 번호는 그대로 둔다", async () => {
    await isolateExistingExceptions();

    const nowFound = world.newTraceNo();
    const stillMissing = world.newTraceNo();

    await failedScanFor(nowFound, 6);
    await failedScanFor(stillMissing, 7);

    fetchTraceMock.mockReset();
    fetchTraceMock.mockImplementation(async (traceNo: string) => (traceNo === nowFound ? apiRecord(nowFound) : null));

    const result = await retryUnresolvedScansAction();

    expect(result).toEqual({ success: true, data: { checked: 2, resolved: 1 } });
    expect((await scanRow(nowFound)).map((row) => row.status).sort()).toEqual(["NORMAL", "VOIDED"]);
    expect((await scanRow(stillMissing)).map((row) => row.status)).toEqual(["EXCEPTION"]);
  });

  it("같은 박스는 30분 안에 다시 조회하지 않는다(정부 API 호출 한도 보호)", async () => {
    await isolateExistingExceptions();

    const missing = world.newTraceNo();

    await failedScanFor(missing, 3);

    fetchTraceMock.mockReset();
    fetchTraceMock.mockResolvedValue(null);

    const first = await retryUnresolvedScansAction();
    const callsAfterFirst = fetchTraceMock.mock.calls.length;
    const second = await retryUnresolvedScansAction();

    expect(first.data).toEqual({ checked: 1, resolved: 0 });
    expect(callsAfterFirst).toBe(1);
    expect(second.data).toEqual({ checked: 0, resolved: 0 });
    expect(fetchTraceMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("한 번에 최대 3건만 처리한다", async () => {
    await isolateExistingExceptions();

    for (let index = 0; index < 4; index += 1) {
      await failedScanFor(world.newTraceNo(), 2 + index);
    }

    fetchTraceMock.mockReset();
    fetchTraceMock.mockResolvedValue(null);

    expect((await retryUnresolvedScansAction()).data).toEqual({ checked: 3, resolved: 0 });
  });

  it("이력 조회 인증키가 없으면 정부 API를 헛호출하지 않는다", async () => {
    await isolateExistingExceptions();

    const missing = world.newTraceNo();

    await failedScanFor(missing, 3);

    fetchTraceMock.mockReset();
    configuredMock.mockReturnValue(false);

    const result = await retryUnresolvedScansAction();

    expect(result.data).toEqual({ checked: 1, resolved: 0 });
    expect(fetchTraceMock).not.toHaveBeenCalled();
    expect((await scanRow(missing)).map((row) => row.status)).toEqual(["EXCEPTION"]);
  });

  it("고객·비로그인은 호출할 수 없다", async () => {
    await actAs(world.users.retailerR);
    expect((await retryUnresolvedScansAction()).success).toBe(false);

    await actAs(null);
    expect((await retryUnresolvedScansAction()).success).toBe(false);
  });
});
