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
 * 국내산(①③)은 2026-09-23에 공식 활용가이드(축산물품질평가원_축산물통합이력정보조회
 * v2.10)로 실주소·파라미터·응답 구조를 확인했다 — 아래 KAPE_ANIMAL_TRACE_ENDPOINT
 * 참고. **부위(部位) 필드는 실제로 없다** — 가이드의 응답 필드 목록에 아예 없어
 * 예상대로 확인됨. 개체번호는 소 한 마리를 가리킬 뿐이라 그렇다. 스캔은
 * PENDING_MAPPING으로 남고 사용자에게 한 번 되묻는다(잠긴 설계 결정 4번).
 *
 * 수입 축산물(②)은 2026-09-23 조사 결과 **①③과 운영 체계 자체가 다르다는 것만
 * 확인했고, 실주소는 여전히 미확인이다**:
 *  - data.go.kr의 "농림축산검역본부_수입축산물이력정보"(15118023)는 "LINK형" 데이터다
 *    — KAPE 이력 API처럼 apis.data.go.kr 게이트웨이에 실제로 얹혀 있는 게 아니라,
 *    운영기관 자체 사이트(meatwatch.go.kr)로 안내만 한다.
 *  - 즉 data.go.kr 계정 공용 인증키(KAPE_MARKET_PRICE_API_KEY 등)로 되는
 *    ①의 폴백 전략이 여기는 아예 통하지 않는다 — 인증 체계 자체가 분리돼 있다.
 *  - meatwatch.go.kr은 "기업 회원가입 → 오픈서비스 이용안내 → 기업전용 오픈서비스
 *    신청 → 가이드 다운로드 + 개별 키 발급" 절차를 따로 밟아야 한다(회원가입 뒤
 *    문서가 열려 있어 로그인 없이는 실주소·파라미터를 확인할 수 없었다).
 *  - 그래서 아래 meatwatch 설정에는 fallbackDataGoKrKey()를 걸지 않는다 — 실패가
 *    뻔한 호출을 한 번 더 보내는 낭비이고, "그냥 안 됐나 보다"로 넘어가는 대신
 *    설정 화면에 "MEATWATCH_API_KEY 별도 발급 필요"라고 정확히 안내하는 게 낫다.
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
  /**
   * 시도할 요청 주소 목록.
   *
   * data.go.kr에서 받은 End Point는 서비스 기본 경로까지만이고
   * (`.../user/grade`), 그 뒤에 붙는 오퍼레이션 이름은 활용가이드 문서를 봐야
   * 안다. 문서 확인 전에도 굴러가도록 후보를 순서대로 시도하고, 한 번 성공한
   * 주소는 프로세스가 사는 동안 기억해 두 번 다시 헤매지 않는다.
   *
   * 정확한 주소를 알게 되면 *_API_ENDPOINT 환경변수로 고정하는 게 좋다 —
   * 후보 탐색이 사라져 첫 호출이 빨라진다.
   */
  endpoints: string[];
  apiKey: string | undefined;
}

/**
 * 축산물품질평가원(KAPE) "축산물통합이력정보조회" 서비스(data.go.kr 개발계정
 * "축산물품질평가원_축산물통합이력정보", 서비스ID SC-OA-21-09)의 실제 주소·파라미터.
 *
 * 사장님이 다운로드한 공식 활용가이드(v2.10)로 2026-09-23에 확인함 — 예전에 웹 검색으로
 * 찾았던 "쇠고기이력정보"(15056898, /mtrace/breeding/cattle, cattleNo 파라미터)는
 * 완전히 다른(더 좁은) 상품이었고 틀렸다. 이 주소 하나로 **소·돼지·닭·오리·계란**
 * 개체/묶음번호를 전부 조회한다(응답의 traceNoType으로 구분됨) — 품목별로 주소를
 * 나눌 필요가 없다.
 *
 * 파라미터: traceNo(이력/묶음번호), optionNo(9=전 구간 정보 — 예제가 전부 9를 씀),
 * corpNo(묶음 구성업소 사업자번호, 옵션). ServiceKey 대소문자는 가이드 예제에서도
 * 섞여 쓰여 서버가 구분하지 않는 것으로 보인다.
 */
const KAPE_ANIMAL_TRACE_ENDPOINT =
  "http://data.ekape.or.kr/openapi-data/service/user/animalTrace/traceNoSearch";

/**
 * 소·돼지 이력은 축산물품질평가원(KAPE)이 운영한다 — 이미 동작 중인 경락가 API
 * (`data.ekape.or.kr`, KAPE_MARKET_PRICE_API_KEY)와 같은 기관이다. data.go.kr은
 * 계정당 공용 인증키를 주므로, 전용 키를 안 넣었으면 그 키로 먼저 시도한다.
 * 별도 발급 없이 바로 될 수 있고, 안 되면 어차피 예외로 남을 뿐이라 손해가 없다.
 */
/** 환경변수로 주소가 고정돼 있으면 그것만, 아니면 후보 목록을 쓴다. */
function candidates(override: string | undefined, defaults: string[]): string[] {
  const fixed = override?.trim();

  return fixed ? [fixed] : defaults;
}

function fallbackDataGoKrKey(): string | undefined {
  return process.env.KAPE_MARKET_PRICE_API_KEY ?? process.env.NTS_BUSINESS_VERIFY_API_KEY;
}

function sourceConfig(source: TraceSource): SourceConfig {
  switch (source) {
    case "meatwatch":
      return {
        label: "meatwatch_imported",
        // ⚠️ 이 주소는 근거 없는 추정치다. data.go.kr 15118023이 "LINK형"으로 확인돼
        //    apis.data.go.kr 게이트웨이에 실제로 존재하지 않을 가능성이 크다(위 헤더
        //    코멘트 참고). meatwatch.go.kr 기업 회원가입 후 발급되는 가이드로 확정
        //    전까지는 MEATWATCH_API_ENDPOINT로 덮어쓰기 전제.
        endpoints: candidates(process.env.MEATWATCH_API_ENDPOINT, [
          "http://apis.data.go.kr/B552895/imported/trace/traceNoSearch",
        ]),
        // meatwatch.go.kr은 data.go.kr과 별도의 회원가입·키 발급 체계다 — 공용키
        // 폴백이 통할 수가 없어 걸지 않는다(위 헤더 코멘트 참고).
        apiKey: process.env.MEATWATCH_API_KEY,
      };
    case "poultry":
      // 공식 가이드(v2.10)에 닭/오리/계란(FOWL·DUCK·EGG)도 같은 animalTrace
      // 엔드포인트로 조회된다고 나와 있다 — 별도 주소가 아니다.
      return {
        label: "poultry_trace",
        endpoints: candidates(process.env.POULTRY_TRACE_API_ENDPOINT, [KAPE_ANIMAL_TRACE_ENDPOINT]),
        apiKey: process.env.POULTRY_TRACE_API_KEY ?? fallbackDataGoKrKey(),
      };
    default:
      return {
        label: "mtrace_livestock",
        // 공식 활용가이드(v2.10, 2026-09-23 확인)로 실주소·파라미터가 확정됐다(위 상수 참고).
        // 소·돼지 둘 다 이 주소 하나로 처리된다.
        endpoints: candidates(process.env.MTRACE_API_ENDPOINT, [KAPE_ANIMAL_TRACE_ENDPOINT]),
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

/**
 * 이 이력번호가 필요로 하는 기관의 인증키가 아예 없어서 난 오류 — 재시도해도
 * 절대 통과하지 않는다. isMtraceConfigured()는 "셋 중 하나라도" 키가 있으면
 * true를 돌려주므로, 소·돼지 키만 있고 닭 키가 없는데 닭을 스캔한 경우처럼
 * "전체적으로는 설정됨"과 "이 건에 필요한 소스는 미설정"이 갈릴 수 있다.
 * 그 차이를 호출부(actions.ts)가 구분해 안내 문구를 바꿀 수 있도록 별도 타입으로 던진다.
 */
export class MtraceNotConfiguredError extends MtraceError {}

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

/**
 * 한 번 성공한 주소는 기억해 다음부터 바로 쓴다.
 * 서버리스라 인스턴스가 바뀌면 초기화되지만, 그래도 같은 인스턴스가 연속으로
 * 처리하는 동안(현장 연속 스캔)은 후보 탐색이 한 번만 일어난다.
 */
const resolvedEndpoint = new Map<TraceSource, string>();

async function callUrl(endpoint: string, apiKey: string, traceNo: string): Promise<unknown> {
  const url = new URL(endpoint);
  // 공식 가이드 예제는 ServiceKey/serviceKey 대소문자가 섞여 있다 — 서버가 구분하지
  // 않는 것으로 보이지만, 혹시 몰라 소문자 쪽으로 보낸다(URLSearchParams 관례와도 맞다).
  url.searchParams.set("serviceKey", apiKey);
  url.searchParams.set("traceNo", traceNo);
  // optionNo·corpNo는 일부러 안 보낸다 — 실호출로 확인함(2026-09-23):
  //  - optionNo=9(가이드 예제가 쓰던 값)는 개체 조회에서 빈 결과만 왔다.
  //  - optionNo를 아예 생략하면 출생·이동·도축·포장·백신 정보가 전부 한 번에 온다
  //    (문서에 안 나온 실제 기본 동작). 콤마로 여러 값을 묶어 보내면 서버 500(Oracle
  //    바인드 오류)이 난다 — 단일값 또는 생략만 된다.
  //  - corpNo도 있으나 없으나 결과가 같았다(개체 조회 기준).

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

/**
 * 후보 주소를 순서대로 시도해 실제 이력이 담긴 응답을 찾는다.
 * 주소가 틀리면 보통 404/빈 응답이라 빠르게 넘어간다.
 */
async function callSource(source: TraceSource, traceNo: string): Promise<unknown | null> {
  const config = sourceConfig(source);

  if (!config.apiKey) {
    throw new MtraceNotConfiguredError(`${source} 인증키 미설정`);
  }

  const known = resolvedEndpoint.get(source);
  const endpoints = known ? [known, ...config.endpoints.filter((url) => url !== known)] : config.endpoints;

  let lastError: MtraceError | null = null;
  // 이번 호출에서 어느 후보든 실제로 응답을 받았는지 — resolvedEndpoint(과거 호출 캐시)로
  // 판정하면, 이전에 다른 이력번호로 한 번이라도 성공한 적이 있다는 이유로 이번 호출의
  // 진짜 장애를 "조회 결과 없음"으로 삼켜버리거나, 반대로 이번 호출에서 늦게 시도한
  // 정상 후보가 응답했는데도 먼저 실패한 엉뚱한 후보의 에러를 올리는 문제가 생긴다.
  let sawSuccessfulResponse = false;

  for (const endpoint of endpoints) {
    try {
      const tree = await callUrl(endpoint, config.apiKey, traceNo);
      // resultCode가 실패를 가리키면 "이력 없음"이 아니라 진짜 오류다 — sawSuccessfulResponse를
      // 세우지 않고 다음 후보로 넘어간다. 전부 이렇게 끝나면 아래에서 이 오류가 그대로 올라간다.
      checkResultCode(tree);
      sawSuccessfulResponse = true;

      if (hasRecord(tree)) {
        resolvedEndpoint.set(source, endpoint);
        return tree;
      }
    } catch (error) {
      lastError = error instanceof MtraceError ? error : new MtraceError(String(error));
    }
  }

  // 이번 호출에서 응답을 하나라도 받았으면 "조회 결과 없음"으로 본다.
  // 전부 호출 자체가 실패했을 때만 오류로 올린다.
  if (lastError && !sawSuccessfulResponse) {
    throw lastError;
  }

  return null;
}

/** 응답에 실제 이력 내용이 담겼는지 — 빈 껍데기(조회 결과 없음)면 false. */
function hasRecord(tree: unknown): boolean {
  return (
    pick(tree, ["traceNo", "cattleNo", "pigNo", "individualNo"]) !== null ||
    pick(tree, ["lsTypeNm", "lsType", "cattleGradeNm", "gradeNm"]) !== null
  );
}

/**
 * data.go.kr 표준 응답은 `<response><header><resultCode>..</resultCode></header></response>`
 * 형태를 쓴다(kape-client.ts에서 이미 같은 패턴 확인). 트리를 재귀 탐색해 찾는다 — 정확한
 * 경로가 오퍼레이션마다 다를 수 있어 kape-client.ts와 같은 전략을 쓴다.
 */
function findResultCode(node: unknown): { code: string | null; msg: string | null } {
  if (!node || typeof node !== "object") {
    return { code: null, msg: null };
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findResultCode(item);
      if (found.code !== null) return found;
    }
    return { code: null, msg: null };
  }

  const obj = node as Record<string, unknown>;

  if ("resultCode" in obj) {
    return {
      code: String(obj.resultCode),
      msg: obj.resultMsg !== undefined ? String(obj.resultMsg) : null,
    };
  }

  for (const value of Object.values(obj)) {
    const found = findResultCode(value);
    if (found.code !== null) return found;
  }

  return { code: null, msg: null };
}

/**
 * resultCode가 있는 응답인데 실패 코드면(서비스키 미등록·활용신청 미승인·한도초과 등) 그건
 * "이력 없음"이 아니라 진짜 오류다. 이걸 구분 안 하면 활용신청을 안 했거나 키가 틀려도
 * 화면에는 "이력을 못 찾았습니다"로만 보여 원인을 영영 못 찾는다(2026-09-22 실제로 겪음 —
 * `serviceKey` 없이 호출했더니 `resultCode 99 "등록되지 않은 서비스키"`가 정상 XML로 왔다).
 * resultCode가 아예 없는 응답(구조 미확인 후보 엔드포인트)은 기존처럼 hasRecord()에만 맡긴다.
 */
function checkResultCode(tree: unknown): void {
  const { code, msg } = findResultCode(tree);

  if (code !== null && code !== "00" && Number(code) !== 0) {
    throw new MtraceError(msg || `이력 조회 API가 오류를 반환했습니다 (코드 ${code}).`);
  }
}

/**
 * mtrace(소·돼지 공용 animalTrace 엔드포인트) 응답은 lsTypeNm 같은 축종
 * 이름 필드를 안 줄 때가 있다 — 실제 돼지 이력 조회로 확인됨(2026-09-23,
 * traceNoType: "PIG|PIG_NO", pigNo 필드만 있고 lsTypeNm류는 전혀 없었음).
 * 대신 hasRecord()가 이미 쓰는 cattleNo/pigNo 필드의 존재 여부로 가른다
 * (그 필드명은 실호출로 검증된 값이라 traceNoType 문자열을 추측하는 것보다 안전하다).
 */
function speciesGroupFromIdField(tree: unknown): string | null {
  if (pick(tree, ["pigNo"]) !== null) return "돼지";
  if (pick(tree, ["cattleNo"]) !== null) return "소";
  return null;
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
        : (normalizeSpeciesGroup(species) ?? speciesGroupFromIdField(tree));

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

      if (tree !== null) {
        return toRecord(traceNo, attempt.kind, attempt.source, tree);
      }
    } catch (error) {
      // 순차 폴백 중 한쪽이 실패해도 다음을 시도한다. 전부 실패하면 마지막 오류를 던진다.
      lastError = error instanceof MtraceError ? error : new MtraceError(String(error));
    }
  }

  if (attempted === 0) {
    throw new MtraceNotConfiguredError("이력 조회 인증키가 설정되지 않았습니다.");
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}
