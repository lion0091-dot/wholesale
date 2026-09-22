/**
 * 축산물이력제(mtrace.go.kr) 오픈API 클라이언트 — 이력번호 조회.
 *
 * ⚠️ 이 파일 작성 시점에 실제 인증키가 없다. 요청/응답 형식을 공개 스펙 문서
 * 기준으로만 작성했으므로, 키가 발급되면 반드시 실제 XML 응답으로 재검증할 것:
 *   - 오퍼레이션 경로와 파라미터명 (traceNo / traceNoType 등)
 *   - 응답 필드명 — 특히 **부위(部位)가 응답에 실제로 오는지**. 국내산 소의
 *     개체식별번호(12자리)는 소 한 마리를 가리키므로 부위가 없을 가능성이 크다.
 *     없으면 record_inbound_scan이 PENDING_MAPPING으로 남기고 사용자에게 되묻는다.
 *   - 묶음번호(15자리) 응답이 구성 개체를 배열로 주는지
 *
 * 그래서 파싱은 정확한 XML 경로에 의존하지 않고, 트리 전체를 재귀 탐색해
 * 알려진 후보 키들을 찾는 방식으로 방어적으로 짰다(kape-client.ts와 같은 전략).
 * 원본 응답 전문은 master_livestock.raw_payload에 그대로 보관하므로, 나중에
 * 실제 필드명이 확인되면 캐시를 버리지 않고 파서만 고치면 된다.
 */

import { XMLParser } from "fast-xml-parser";

/** 국내산 소·돼지 이력정보 조회 */
const LIVESTOCK_ENDPOINT =
  "http://data.mtrace.go.kr/openapi-data/service/user/animal/trace/traceNoSearch";

/** 수입 쇠고기 유통이력 조회 */
const IMPORTED_ENDPOINT =
  "http://data.mtrace.go.kr/openapi-data/service/user/imported/trace/traceNoSearch";

const REQUEST_TIMEOUT_MS = 8_000;

/** 이력번호 종류 — 자릿수로 1차 판별한다. */
export type TraceKind = "individual" | "group" | "imported";

export interface MtraceRecord {
  traceNo: string;
  traceKind: TraceKind;
  /** 'mtrace_livestock' | 'mtrace_imported' */
  source: string;
  /** API 원문 축종 (한우/육우/젖소/돼지 등) */
  species: string | null;
  /** products.category와 맞춘 정규화값 (소/돼지) */
  speciesGroup: string | null;
  /** 부위 — 응답에 없을 수 있다(위 주의사항 참고) */
  partName: string | null;
  grade: string | null;
  slaughterDate: string | null;
  packingDate: string | null;
  butcheryPlace: string | null;
  farmName: string | null;
  originCountry: string | null;
  importerName: string | null;
  /** 원본 응답 전문 — master_livestock.raw_payload에 그대로 넣는다 */
  rawPayload: unknown;
}

export class MtraceError extends Error {}

/** MTRACE_API_KEY 설정 여부 — 미설정이면 스캔 화면이 "이력 조회 미설정"으로 안전하게 빠진다. */
export function isMtraceConfigured(): boolean {
  return Boolean(process.env.MTRACE_API_KEY);
}

/**
 * 이력번호 형식 판별.
 *
 * 국내산 개체식별번호는 12자리 숫자, 묶음번호는 'L'로 시작하는 15자리가 일반적이다.
 * 수입육 유통식별번호는 체계가 달라 숫자 외 문자가 섞이거나 자릿수가 다르다.
 * 자릿수 규칙은 확정 스펙이 아니므로, 판별에 실패해도 국내산 → 수입 순으로
 * 순차 호출하는 폴백을 둔다(fetchTraceRecord 참고).
 */
export function detectTraceKind(traceNo: string): TraceKind | null {
  const value = traceNo.trim().toUpperCase();

  if (/^\d{12}$/.test(value)) {
    return "individual";
  }

  if (/^L\d{14}$/.test(value) || /^\d{15}$/.test(value)) {
    return "group";
  }

  return null;
}

/** 이력번호로 쓸 수 있는 형태인지 — 스캔 오입력(빈 값, 너무 짧음)을 걸러낸다. */
export function isPlausibleTraceNo(traceNo: string): boolean {
  const value = traceNo.trim();

  return value.length >= 10 && value.length <= 20 && /^[A-Za-z0-9-]+$/.test(value);
}

/** API 원문 축종을 products.category 표기로 정규화한다. 모르는 값은 null. */
function normalizeSpeciesGroup(species: string | null): string | null {
  if (!species) {
    return null;
  }

  if (/한우|육우|젖소|소/.test(species)) {
    return "소";
  }

  if (/돼지|돈/.test(species)) {
    return "돼지";
  }

  return null;
}

/** 파싱된 트리를 재귀 탐색해 후보 키 중 처음 발견되는 값을 문자열로 돌려준다. */
function pick(node: unknown, keys: string[]): string | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pick(item, keys);
      if (found !== null) return found;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;

  for (const key of keys) {
    const value = obj[key];

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  for (const value of Object.values(obj)) {
    const found = pick(value, keys);
    if (found !== null) return found;
  }

  return null;
}

/** YYYYMMDD / YYYY-MM-DD 어느 쪽으로 오든 ISO 날짜(YYYY-MM-DD)로 맞춘다. */
function normalizeDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, "");

  if (digits.length !== 8) {
    return null;
  }

  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/**
 * fast-xml-parser 주의: 기본 설정이 "00" 같은 문자열을 숫자 0으로 바꾼다.
 * 이력번호가 0으로 시작하는 경우가 흔해서 숫자 변환을 꺼야 한다
 * (kape-client.ts에서 resultCode "00" 비교로 같은 함정을 이미 겪었다).
 */
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

async function callEndpoint(endpoint: string, traceNo: string): Promise<unknown> {
  const apiKey = process.env.MTRACE_API_KEY;

  if (!apiKey) {
    throw new MtraceError("MTRACE_API_KEY 미설정");
  }

  const url = new URL(endpoint);
  url.searchParams.set("serviceKey", apiKey);
  url.searchParams.set("traceNo", traceNo);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new MtraceError(`이력 조회 응답 오류 (HTTP ${response.status})`);
    }

    return parser.parse(await response.text());
  } catch (error) {
    if (error instanceof MtraceError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new MtraceError("이력 조회 시간 초과");
    }

    throw new MtraceError(error instanceof Error ? error.message : "이력 조회 실패");
  } finally {
    clearTimeout(timer);
  }
}

/** 응답에 실제 이력 내용이 담겼는지 — 빈 껍데기(조회 결과 없음)면 false. */
function hasRecord(tree: unknown): boolean {
  return (
    pick(tree, ["traceNo", "cattleNo", "pigNo", "individualNo"]) !== null ||
    pick(tree, ["lsTypeNm", "lsType", "cattleGradeNm", "gradeNm"]) !== null
  );
}

function toRecord(traceNo: string, traceKind: TraceKind, tree: unknown): MtraceRecord {
  const isImported = traceKind === "imported";

  const species = pick(tree, ["lsTypeNm", "lsType", "species", "animalKindNm"]);

  return {
    traceNo,
    traceKind,
    source: isImported ? "mtrace_imported" : "mtrace_livestock",
    species,
    speciesGroup: isImported ? "소" : normalizeSpeciesGroup(species),
    // 부위는 국내산 개체번호 응답에 없을 가능성이 크다 — 없으면 null로 두고
    // 스캔 처리 쪽에서 사용자에게 한 번 물어본다.
    partName: pick(tree, ["partNm", "partName", "cutMeatNm", "itemNm"]),
    grade: pick(tree, ["gradeNm", "cattleGradeNm", "qgradeNm", "gradeCd"]),
    slaughterDate: normalizeDate(pick(tree, ["butcheryYmd", "slaughterYmd", "butcheryDate"])),
    packingDate: normalizeDate(pick(tree, ["processYmd", "packingYmd", "packDate", "prcsYmd"])),
    butcheryPlace: pick(tree, ["butcheryPlaceNm", "abattNm", "butcheryPlace"]),
    farmName: pick(tree, ["farmNm", "farmerNm", "farmName"]),
    originCountry: pick(tree, ["natNm", "originNm", "countryNm"]),
    importerName: pick(tree, ["importerNm", "impCompanyNm", "importer"]),
    rawPayload: tree,
  };
}

/**
 * 이력번호 1건 조회.
 *
 * 형식 판별에 실패하면 국내산 → 수입 순으로 순차 호출한다. 두 곳 다 결과가
 * 없으면 null을 돌려주고, 호출 자체가 실패하면 MtraceError를 던진다.
 * 호출부(스캔 처리)는 이 둘을 구분해서 NOT_FOUND / API_ERROR로 나눠 기록한다.
 */
export async function fetchTraceRecord(traceNoInput: string): Promise<MtraceRecord | null> {
  const traceNo = traceNoInput.trim().toUpperCase();

  if (!isPlausibleTraceNo(traceNo)) {
    return null;
  }

  const detected = detectTraceKind(traceNo);

  const attempts: Array<{ endpoint: string; kind: TraceKind }> =
    detected === null
      ? [
          { endpoint: LIVESTOCK_ENDPOINT, kind: "individual" },
          { endpoint: IMPORTED_ENDPOINT, kind: "imported" },
        ]
      : [{ endpoint: LIVESTOCK_ENDPOINT, kind: detected }];

  let lastError: MtraceError | null = null;

  for (const attempt of attempts) {
    try {
      const tree = await callEndpoint(attempt.endpoint, traceNo);

      if (hasRecord(tree)) {
        return toRecord(traceNo, attempt.kind, tree);
      }
    } catch (error) {
      // 순차 폴백 중 한쪽이 실패해도 다음을 시도한다. 전부 실패하면 마지막 오류를 던진다.
      lastError = error instanceof MtraceError ? error : new MtraceError(String(error));
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}
