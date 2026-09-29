/**
 * 수입축산물 이력정보 조회 (data.mafra.go.kr, 농림축산검역본부 운영, 등록일 2014-10-20).
 *
 * mtrace-client.ts의 "meatwatch" 소스와는 완전히 다른 요청 구조라 별도 파일로 뺐다.
 * 국내산(mtrace) API는 이력번호 하나로 바로 그 개체를 조회하지만, 이 API는
 * **이력번호로 직접 검색하는 파라미터가 아예 없다** — 필수 파라미터는 `IMPORT_DE`
 * (수입일자)뿐이고, 이력번호(`DISTB_IDNTFC_NO`)는 응답에만 나오는 출력 필드다.
 * 그래서 "번호 하나 → 결과 하나"가 아니라 "그 날짜의 목록을 받아 그 안에서
 * 번호가 일치하는 줄을 찾는" 방식으로만 조회할 수 있다.
 *
 * 이 제약 때문에 현장 스캔(실시간, 8초 타임아웃) 흐름에는 안 붙이고, 사무실에서
 * 날짜를 알고 있는 상태로 직접 조회하는 별도 도구(`/dashboard/inbound/imported-lookup`)
 * 로만 쓴다 — 스캔 한 번에 날짜별 API를 여러 번(최악의 경우 수십 번) 부르는 건
 * 이 프로젝트의 기존 실시간 스캔 지연 관례에 맞지 않는다.
 *
 * 2026-09-28에 실제 발급받은 키로 실호출 검증 완료 — 문서(엑셀 활용가이드)에 적힌
 * 경로 방식(`/openapi/{API_KEY}/{TYPE}/{GRID_ID}/{시작}/{끝}?IMPORT_DE=...`)이
 * 정상 동작한다. 쿼리스트링으로 API_KEY를 넘기는 방식은 실패(홈페이지로 리다이렉트).
 */

const DEFAULT_BASE = "http://211.237.50.150:7080/openapi";
const DEFAULT_GRID_ID = "Grid_20141226000000000174_1";

/** 한 번 요청에 받을 수 있는 최대 건수 — 문서의 ERROR-336(최대 1000건) 기준. */
const PAGE_SIZE = 500;
/** 하루치가 비정상적으로 많아도 무한정 페이징하지 않게 거는 상한. */
const MAX_TOTAL_FETCH = 5_000;

const REQUEST_TIMEOUT_MS = 8_000;

export class MeatwatchError extends Error {}

export class MeatwatchNotConfiguredError extends MeatwatchError {}

export interface ImportedTraceFilters {
  /** 품목 코드 */
  productCode?: string;
  /** 품목 명 */
  productName?: string;
  /** 선하증권 번호 */
  blNo?: string;
  /** 원산지 국가명 */
  originNation?: string;
}

export interface ImportedTraceRecord {
  /** 유통식별번호 — 이 값이 스캔한 이력번호와 대조하는 기준이다. */
  distributionId: string;
  productCode: string | null;
  productName: string | null;
  blNo: string | null;
  /** API가 그 번호 자체를 어떻게 판정했는지(정상/위해 등) 원문 그대로. */
  status: string | null;
  importDate: string | null;
  originCode: string | null;
  originCountry: string | null;
  quantity: number | null;
  weight: number | null;
  exportSlaughterStart: string | null;
  exportSlaughterEnd: string | null;
  exportProcessStart: string | null;
  exportProcessEnd: string | null;
  distributionLimitStart: string | null;
  distributionLimitEnd: string | null;
  /** 냉동/냉장구분 — "냉동" 또는 "냉장"(REFRIG_COLDRE_SE, 값과 품목명(냉동OO/냉장OO) 상관관계로 확인함). 코드 밖이면 원본 코드 그대로. */
  refrigeration: string | null;
  /** 냉동전환구분(REFRIG_CNVRS_SE) — 원문 코드 그대로("Y"/"N" 등, 정확한 의미는 미확인). */
  refrigerationConverted: string | null;
  sold: string | null;
  rawPayload: unknown;
}

const REFRIG_LABELS: Record<string, string> = {
  "1": "냉동",
  "2": "냉장",
};

export interface ImportedTraceSearchResult {
  records: ImportedTraceRecord[];
  totalCount: number;
  /** MAX_TOTAL_FETCH에 걸려 목록을 다 못 받았는지 — 화면이 "더 좁혀서 검색하세요"로 안내할 때 쓴다. */
  truncated: boolean;
}

function isConfigured(): boolean {
  return Boolean(process.env.MEATWATCH_API_KEY);
}

function baseUrl(): string {
  return (process.env.MEATWATCH_API_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, "");
}

function gridId(): string {
  return process.env.MEATWATCH_GRID_ID?.trim() || DEFAULT_GRID_ID;
}

/** YYYY-MM-DD 또는 YYYYMMDD 어느 쪽으로 와도 API가 요구하는 YYYYMMDD로 맞춘다. */
function toApiDate(value: string): string {
  const digits = value.replace(/\D/g, "");

  if (digits.length !== 8) {
    throw new MeatwatchError("수입일자는 YYYYMMDD 형식이어야 합니다.");
  }

  return digits;
}

function normalizeDate(value: unknown): string | null {
  const str = value === null || value === undefined ? "" : String(value).trim();
  const digits = str.replace(/\D/g, "");

  if (digits.length !== 8) {
    return null;
  }

  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const str = String(value).trim();
  return str === "" ? null : str;
}

function toRecord(row: Record<string, unknown>): ImportedTraceRecord {
  return {
    distributionId: String(row.DISTB_IDNTFC_NO ?? "").trim(),
    productCode: toStringOrNull(row.PRDLST_CD),
    productName: toStringOrNull(row.PRDLST_NM),
    blNo: toStringOrNull(row.BL_NO),
    status: toStringOrNull(row.STTUS),
    importDate: normalizeDate(row.IMPORT_DE),
    originCode: toStringOrNull(row.ORGPLCE_CD),
    originCountry: toStringOrNull(row.ORGPLCE_NATION),
    quantity: toNumber(row.QY),
    weight: toNumber(row.WT),
    exportSlaughterStart: normalizeDate(row.EXCOURY_SLAU_START_DE),
    exportSlaughterEnd: normalizeDate(row.EXCOURY_SLAU_END_DE),
    exportProcessStart: normalizeDate(row.EXCOURY_PRCSS_START_DE),
    exportProcessEnd: normalizeDate(row.EXCOURY_PRCSS_END_DE),
    distributionLimitStart: normalizeDate(row.DISTB_TMLMT_START_DE),
    distributionLimitEnd: normalizeDate(row.DISTB_TMLMT_END_DE),
    refrigeration: (() => {
      const code = toStringOrNull(row.REFRIG_COLDRE_SE);
      return code ? (REFRIG_LABELS[code] ?? code) : null;
    })(),
    refrigerationConverted: toStringOrNull(row.REFRIG_CNVRS_SE),
    sold: toStringOrNull(row.SLE_AT),
    rawPayload: row,
  };
}

async function fetchPage(
  importDate: string,
  startIndex: number,
  endIndex: number,
  filters: ImportedTraceFilters
): Promise<{ totalCnt: number; rows: Record<string, unknown>[] }> {
  const apiKey = process.env.MEATWATCH_API_KEY;

  if (!apiKey) {
    throw new MeatwatchNotConfiguredError("MEATWATCH_API_KEY가 설정되지 않았습니다.");
  }

  const url = new URL(`${baseUrl()}/${apiKey}/json/${gridId()}/${startIndex}/${endIndex}`);
  url.searchParams.set("IMPORT_DE", importDate);
  if (filters.productCode) url.searchParams.set("PRDLST_CD", filters.productCode);
  if (filters.productName) url.searchParams.set("PRDLST_NM", filters.productName);
  if (filters.blNo) url.searchParams.set("BL_NO", filters.blNo);
  if (filters.originNation) url.searchParams.set("ORGPLCE_NATION", filters.originNation);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let body: unknown;
  try {
    const response = await fetch(url.toString(), { signal: controller.signal, cache: "no-store" });

    if (!response.ok) {
      throw new MeatwatchError(`수입이력 조회 응답 오류 (HTTP ${response.status})`);
    }

    const text = await response.text();

    try {
      body = JSON.parse(text);
    } catch {
      // API_KEY가 틀리거나 요청이 아예 잘못되면 JS 리다이렉트 스니펫 같은 비-JSON이 온다
      // (실호출로 확인함 — 쿼리스트링 방식 시도 시 data.mafra.go.kr로 리다이렉트).
      throw new MeatwatchError("수입이력 API가 예상과 다른 응답을 반환했습니다 — 요청 형식을 확인해주세요.");
    }
  } catch (error) {
    if (error instanceof MeatwatchError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new MeatwatchError("수입이력 조회 시간 초과");
    }
    throw new MeatwatchError(error instanceof Error ? error.message : "수입이력 조회 실패");
  } finally {
    clearTimeout(timer);
  }

  const grid = (body as Record<string, unknown>)?.[gridId()] as Record<string, unknown> | undefined;

  if (!grid) {
    throw new MeatwatchError("수입이력 API 응답 형식이 예상과 다릅니다.");
  }

  const result = grid.result as Record<string, unknown> | undefined;
  const code = result?.code !== undefined ? String(result.code) : null;

  // INFO-200(데이터 없음)은 오류가 아니라 빈 결과다. 그 외 INFO/ERROR 코드는 진짜 오류.
  if (code !== null && code !== "INFO-000" && code !== "INFO-200") {
    throw new MeatwatchError(String(result?.message ?? `수입이력 API 오류 (${code})`));
  }

  const rawRow = grid.row;
  const rows: Record<string, unknown>[] = Array.isArray(rawRow)
    ? (rawRow as Record<string, unknown>[])
    : rawRow && typeof rawRow === "object"
      ? [rawRow as Record<string, unknown>]
      : [];

  return { totalCnt: toNumber(grid.totalCnt) ?? rows.length, rows };
}

/**
 * 특정 수입일자(+선택 필터)의 수입축산물 이력 전체를 가져온다.
 * totalCnt가 MAX_TOTAL_FETCH를 넘으면 그 지점까지만 받고 truncated=true를 돌려준다
 * (화면이 필터를 더 좁히라고 안내한다).
 */
export async function searchImportedTrace(
  importDateInput: string,
  filters: ImportedTraceFilters = {}
): Promise<ImportedTraceSearchResult> {
  if (!isConfigured()) {
    throw new MeatwatchNotConfiguredError("MEATWATCH_API_KEY가 설정되지 않았습니다.");
  }

  const importDate = toApiDate(importDateInput);

  const records: ImportedTraceRecord[] = [];
  let totalCount = 0;
  let start = 1;

  for (;;) {
    const end = start + PAGE_SIZE - 1;
    const page = await fetchPage(importDate, start, end, filters);

    totalCount = page.totalCnt;
    records.push(...page.rows.map(toRecord));

    if (records.length >= totalCount || page.rows.length === 0 || records.length >= MAX_TOTAL_FETCH) {
      break;
    }

    start = end + 1;
  }

  return { records, totalCount, truncated: records.length < totalCount };
}

/** 수입일자를 알고 있는 상태에서 특정 유통식별번호(이력번호) 한 건을 찾는다. */
export async function findImportedTraceByDistributionId(
  importDateInput: string,
  distributionId: string,
  filters: ImportedTraceFilters = {}
): Promise<ImportedTraceRecord | null> {
  const target = distributionId.trim();
  const { records } = await searchImportedTrace(importDateInput, filters);

  return records.find((record) => record.distributionId === target) ?? null;
}
