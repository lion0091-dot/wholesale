/**
 * 축산물 이력 조회 클라이언트 — 품목별로 운영 기관이 달라 3갈래로 라우팅한다.
 *
 *   ① 국내산 소·돼지   → 축산물이력제 (mtrace.go.kr, 축산물품질평가원)
 *   ② 수입 축산물       → 수입축산물 이력관리시스템 (meatwatch.go.kr)
 *   ③ 닭·오리·계란      → 가금류 이력관리시스템
 *
 * 세 시스템은 인증키도 따로 발급받아야 할 수 있어 환경변수를 분리했다. 설정된
 * 소스만 시도하고, 미설정 소스는 조용히 건너뛴다 — 소·돼지만 취급하는 업체는
 * MTRACE_API_KEY 하나만 넣으면 된다.
 *
 * ⚠️ 이 파일 작성 시점에 인증키가 하나도 없다. 엔드포인트 주소·파라미터명·응답
 * 필드명이 전부 문서 기준 추정이므로, 키가 발급되면 실제 응답으로 재검증할 것.
 * 특히 **부위(部位)가 응답에 실제로 오는지** — 국내산 소의 개체식별번호(12자리)는
 * 소 한 마리를 가리키므로 부위가 없을 가능성이 크다. 없으면 스캔이
 * PENDING_MAPPING으로 남고 사용자에게 한 번 되묻는다.
 *
 * 파싱은 정확한 XML 경로에 의존하지 않고 트리를 재귀 탐색해 후보 키를 찾는다
 * (kape-client.ts와 같은 전략). 원본 응답은 master_livestock.raw_payload에
 * 통째로 보관하므로, 실제 필드명이 확인되면 캐시를 버리지 않고 파서만 고치면 된다.
 */

import { XMLParser } from "fast-xml-parser";

/**
 * 이력 조회 소스 — 품목별 운영 기관이 다르다.
 * 엔드포인트는 전부 추정값이므로 환경변수로 덮어쓸 수 있게 해뒀다(실호출로 확인한
 * 주소가 생기면 코드 수정 없이 .env만 고치면 된다).
 */
export type TraceSource = "mtrace" | "meatwatch" | "poultry";

interface SourceConfig {
  /** master_livestock.source에 기록되는 값 */
  label: string;
  endpoint: string;
  apiKey: string | undefined;
}

/**
 * 소·돼지 이력은 축산물품질평가원(KAPE)이 운영한다 — 이미 동작 중인 경락가 API
 * (`data.ekape.or.kr`, KAPE_MARKET_PRICE_API_KEY)와 같은 기관이다. data.go.kr은
 * 계정당 공용 인증키를 주므로, 전용 키를 안 넣었으면 그 키로 먼저 시도한다.
 * 별도 발급 없이 바로 될 수 있고, 안 되면 어차피 예외로 남을 뿐이라 손해가 없다.
 */
function fallbackDataGoKrKey(): string | undefined {
  return process.env.KAPE_MARKET_PRICE_API_KEY ?? process.env.NTS_BUSINESS_VERIFY_API_KEY;
}

function sourceConfig(source: TraceSource): SourceConfig {
  switch (source) {
    case "meatwatch":
      return {
        label: "meatwatch_imported",
        // ⚠️ 이 주소는 미확인이다. 실제로 연결되는지 확인된 바 없으므로
        //    MEATWATCH_API_ENDPOINT로 덮어쓸 것.
        endpoint:
          process.env.MEATWATCH_API_ENDPOINT ??
          "http://apis.data.go.kr/B552895/imported/trace/traceNoSearch",
        // 수입 이력은 운영 기관이 달라 공용키가 통하지 않을 수 있다 — 그래도
        // 전용 키가 없으면 한 번은 시도해본다.
        apiKey: process.env.MEATWATCH_API_KEY ?? fallbackDataGoKrKey(),
      };
    case "poultry":
      return {
        label: "poultry_trace",
        endpoint:
          process.env.POULTRY_TRACE_API_ENDPOINT ??
          "http://data.ekape.or.kr/openapi-data/service/user/poultry/trace/traceNoSearch",
        apiKey: process.env.POULTRY_TRACE_API_KEY ?? fallbackDataGoKrKey(),
      };
    default:
      return {
        label: "mtrace_livestock",
        // KAPE 경락가 API와 같은 도메인 체계를 기본값으로 둔다 — 같은 기관이
        // 운영하므로 가장 가능성이 높다. 실제 주소가 확인되면 .env로 덮어쓴다.
        endpoint:
          process.env.MTRACE_API_ENDPOINT ??
          "http://data.ekape.or.kr/openapi-data/service/user/animal/trace/traceNoSearch",
        apiKey: process.env.MTRACE_API_KEY ?? fallbackDataGoKrKey(),
      };
  }
}

const REQUEST_TIMEOUT_MS = 8_000;

/** 이력번호 종류 — 자릿수/접두어로 1차 판별한다. */
export type TraceKind = "individual" | "group" | "imported" | "poultry";

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

/** 어느 소스든 하나라도 키가 있으면 이력 조회가 동작한다. */
export function isMtraceConfigured(): boolean {
  return (["mtrace", "meatwatch", "poultry"] as TraceSource[]).some(
    (source) => Boolean(sourceConfig(source).apiKey)
  );
}

/** 설정된 소스 목록 — 설정 화면에서 "어디까지 조회되는지" 안내할 때 쓴다. */
export function configuredTraceSources(): TraceSource[] {
  return (["mtrace", "meatwatch", "poultry"] as TraceSource[]).filter(
    (source) => Boolean(sourceConfig(source).apiKey)
  );
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

  // 국내산 소 개체식별번호: 12자리 숫자
  if (/^\d{12}$/.test(value)) {
    return "individual";
  }

  // 묶음번호: L + 14자리, 또는 15자리 숫자
  if (/^L\d{14}$/.test(value) || /^\d{15}$/.test(value)) {
    return "group";
  }

  // 수입 유통식별번호는 영문 접두어가 붙는 경우가 많다(체계 미확정).
  if (/^[A-Z]{1,3}\d{8,}$/.test(value)) {
    return "imported";
  }

  return null;
}

/** 판별 결과를 어느 기관 API로 보낼지로 옮긴다. */
function sourceForKind(kind: TraceKind): TraceSource {
  if (kind === "imported") return "meatwatch";
  if (kind === "poultry") return "poultry";
  return "mtrace";
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

async function callSource(source: TraceSource, traceNo: string): Promise<unknown> {
  const config = sourceConfig(source);

  if (!config.apiKey) {
    throw new MtraceError(`${source} 인증키 미설정`);
  }

  const url = new URL(config.endpoint);
  url.searchParams.set("serviceKey", config.apiKey);
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

function toRecord(
  traceNo: string,
  traceKind: TraceKind,
  source: TraceSource,
  tree: unknown
): MtraceRecord {
  const species = pick(tree, ["lsTypeNm", "lsType", "species", "animalKindNm"]);

  const speciesGroup =
    source === "meatwatch"
      ? // 수입은 쇠고기·돈육이 섞여 들어온다 — 원문 축종으로 가르고, 못 가르면 null.
        normalizeSpeciesGroup(species)
      : source === "poultry"
        ? "닭/오리"
        : normalizeSpeciesGroup(species);

  return {
    traceNo,
    traceKind,
    source: sourceConfig(source).label,
    species,
    speciesGroup,
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

  // 형식으로 갈렸으면 해당 기관만, 아니면 설정된 기관을 순서대로 시도한다.
  // 소·돼지만 취급하는 업체는 MTRACE_API_KEY만 있으므로 한 번만 호출된다.
  const attempts: Array<{ source: TraceSource; kind: TraceKind }> =
    detected !== null
      ? [{ source: sourceForKind(detected), kind: detected }]
      : [
          { source: "mtrace", kind: "individual" },
          { source: "meatwatch", kind: "imported" },
          { source: "poultry", kind: "poultry" },
        ];

  let lastError: MtraceError | null = null;
  let attempted = 0;

  for (const attempt of attempts) {
    if (!sourceConfig(attempt.source).apiKey) {
      continue; // 키가 없는 기관은 건너뛴다(오류로 치지 않는다).
    }

    attempted += 1;

    try {
      const tree = await callSource(attempt.source, traceNo);

      if (hasRecord(tree)) {
        return toRecord(traceNo, attempt.kind, attempt.source, tree);
      }
    } catch (error) {
      // 순차 폴백 중 한쪽이 실패해도 다음을 시도한다. 전부 실패하면 마지막 오류를 던진다.
      lastError = error instanceof MtraceError ? error : new MtraceError(String(error));
    }
  }

  if (attempted === 0) {
    throw new MtraceError("이력 조회 인증키가 설정되지 않았습니다.");
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}
