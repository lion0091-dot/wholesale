/**
 * 축산물 박스에서 읽히는 값을 해석해 이력번호(와 가능하면 중량·포장일)를 뽑아낸다.
 *
 * 현장 박스 라벨은 한 가지가 아니다:
 *
 *   ① 순수 이력번호        "002123456789"
 *   ② GS1-128 물류 바코드  "01880123456789033103008200 11260813 10LOT123"
 *   ③ 소비자용 QR           "https://mtrace.go.kr/...?traceNo=002123456789"
 *
 * ②는 식육포장처리업체가 붙이는 표준 바코드로 **중량이 들어 있다** — 이걸 읽어내면
 * 작업자가 중량을 손으로 칠 필요가 없다. ③은 URL이라 번호만 골라내야 한다.
 *
 * 어느 형태로 들어와도 같은 결과를 내도록 한 곳에서 처리한다. 판별에 실패하면
 * 문자열 안에서 이력번호처럼 생긴 숫자를 찾는 폴백으로 내려간다.
 */

export type BarcodeFormat = "plain" | "gs1" | "url" | "bundle" | "unknown";

export interface ParsedBarcode {
  /** 뽑아낸 이력번호. 못 찾으면 null */
  traceNo: string | null;
  /** GS1에서 읽어낸 중량(kg). 없으면 null */
  weightKg: number | null;
  /** 포장/생산일 (YYYY-MM-DD). 없으면 null */
  packingDate: string | null;
  /** 유통기한 (YYYY-MM-DD) */
  bestBefore: string | null;
  lotNo: string | null;
  gtin: string | null;
  format: BarcodeFormat;
  /** 스캐너가 보낸 원본 — 해석이 틀렸을 때 추적용 */
  raw: string;
}

/** 개체식별번호 12자리 또는 묶음번호(L+14 / 15자리). */
const TRACE_PATTERN = /(?:^|[^0-9A-Z])(L\d{14}|\d{15}|\d{12})(?:[^0-9A-Z]|$)/;

/**
 * 우리가 발행한 자체 세트번호 (SET-YYMMDD-NNN, 23단계).
 *
 * 정부 이력번호가 아니라 세트 박스 한 개의 식별자다. 출고 스캔은 inbound_scans의
 * trace_no로 박스를 찾으므로 이 번호도 같은 자리에 들어간다 — 그래서 파서가
 * 이 형태를 알아야 세트 박스를 찍을 수 있다. 숫자 자릿수 폴백에는 걸리지 않는다.
 */
const BUNDLE_SET_PATTERN = /^SET-\d{6}-\d{3,6}$/;

/**
 * GS1-128 고정길이 AI. 값 길이가 정해져 있어 구분자 없이 이어 붙는다.
 * (가변길이 AI는 FNC1/GS(0x1D)나 문자열 끝까지가 값이다)
 */
const FIXED_LENGTH_AI: Record<string, number> = {
  "00": 18, // SSCC
  "01": 14, // GTIN
  "02": 14,
  "11": 6, // 생산일
  "12": 6, // 지급기한
  "13": 6, // 포장일
  "15": 6, // 품질유지기한
  "16": 6,
  "17": 6, // 유통기한
  "20": 2,
};

/** 3자리 소수점 자리수를 마지막 한 자리로 표현하는 계량 AI (310n=kg, 320n=lb 등) */
const MEASURE_AI_PREFIX = /^3[0-5]\d$/;

const GS = "\u001d";

function pad4Ai(value: string, at: number): string {
  return value.slice(at, at + 4);
}

/** YYMMDD → YYYY-MM-DD. GS1은 2자리 연도라 50을 기준으로 세기를 가른다(GS1 규칙). */
function gs1Date(value: string): string | null {
  if (!/^\d{6}$/.test(value)) {
    return null;
  }

  const yy = Number(value.slice(0, 2));
  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  const month = value.slice(2, 4);
  // GS1은 "일자 미지정"을 00으로 표현한다 — 그 달 1일로 본다.
  const day = value.slice(4, 6) === "00" ? "01" : value.slice(4, 6);

  return `${year}-${month}-${day}`;
}

/** 괄호 표기 "(01)880...(3103)008200" 을 순수 문자열로 편다. */
function stripParentheses(value: string): string {
  return value.replace(/\((\d{2,4})\)/g, "$1");
}

/**
 * parseGs1이 실제로 처리할 줄 아는 AI 코드 전체(고정길이 + 가변길이 + 계량).
 * "01"(GTIN)만 하드코딩해 판별하던 예전 방식은 AI "00"(SSCC)으로 시작하는
 * 상자 단위 물류 라벨(박스 여러 개를 묶은 겉박스)을 놓쳤다 — 구분자 없이 고정길이
 * 필드만 이어붙으면 문자열 전체가 숫자만 남아 뒤의 이력번호까지 못 찾는 사고였다.
 */
const KNOWN_VARIABLE_AI2 = new Set(["10", "21"]);
const KNOWN_VARIABLE_AI3 = new Set(["240", "241", "251"]);

function startsWithKnownAi(strippedValue: string): boolean {
  const ai2 = strippedValue.slice(0, 2);
  const ai3 = strippedValue.slice(0, 3);

  return (
    ai2 in FIXED_LENGTH_AI ||
    KNOWN_VARIABLE_AI2.has(ai2) ||
    KNOWN_VARIABLE_AI3.has(ai3) ||
    MEASURE_AI_PREFIX.test(ai3)
  );
}

function looksLikeGs1(value: string): boolean {
  if (value.includes(GS)) {
    return true;
  }

  if (/^\(\d{2,4}\)/.test(value)) {
    return true;
  }

  return startsWithKnownAi(stripParentheses(value));
}

/**
 * GS1-128 요소열을 훑어 AI별 값을 뽑는다.
 * 모르는 AI를 만나면 더 진행하지 않고 그때까지 읽은 것만 돌려준다 — 잘못 잘라서
 * 엉뚱한 값을 만드는 것보다 낫다.
 */
function parseGs1(input: string): Partial<ParsedBarcode> {
  const value = stripParentheses(input);
  const result: Partial<ParsedBarcode> = {};

  let index = 0;

  while (index < value.length) {
    // 구분자는 건너뛴다.
    if (value[index] === GS) {
      index += 1;
      continue;
    }

    const ai2 = value.slice(index, index + 2);
    const ai4 = pad4Ai(value, index);

    // 계량 AI는 4자리(310n 등)를 먼저 본다.
    if (MEASURE_AI_PREFIX.test(ai4.slice(0, 3)) && /^\d$/.test(ai4[3] ?? "")) {
      const decimals = Number(ai4[3]);
      const raw = value.slice(index + 4, index + 10);

      if (/^\d{6}$/.test(raw)) {
        const amount = Number(raw) / 10 ** decimals;

        // 310n = kg, 그 외 계량 단위는 이 시스템에서 쓰지 않는다.
        if (ai4.startsWith("310")) {
          result.weightKg = amount;
        }
      }

      index += 10;
      continue;
    }

    const fixed = FIXED_LENGTH_AI[ai2];

    if (fixed !== undefined) {
      const raw = value.slice(index + 2, index + 2 + fixed);

      if (ai2 === "01") result.gtin = raw;
      if (ai2 === "11" || ai2 === "13") result.packingDate = gs1Date(raw) ?? result.packingDate ?? null;
      if (ai2 === "15" || ai2 === "17") result.bestBefore = gs1Date(raw) ?? result.bestBefore ?? null;

      index += 2 + fixed;
      continue;
    }

    // 가변길이 AI — 구분자나 끝까지가 값이다.
    if (ai2 === "10" || ai2 === "21") {
      const rest = value.slice(index + 2);
      const end = rest.indexOf(GS);
      const raw = end === -1 ? rest : rest.slice(0, end);

      if (ai2 === "10") result.lotNo = raw;

      index += 2 + raw.length;
      continue;
    }

    // 251(원산지 추적코드) 등 3자리 가변 AI — 이력번호가 여기 실리는 경우가 있다.
    const ai3 = value.slice(index, index + 3);

    if (ai3 === "251" || ai3 === "240" || ai3 === "241") {
      const rest = value.slice(index + 3);
      const end = rest.indexOf(GS);
      const raw = end === -1 ? rest : rest.slice(0, end);

      if (ai3 === "251") {
        result.traceNo = raw.trim().toUpperCase();
      }

      index += 3 + raw.length;
      continue;
    }

    // 모르는 AI — 여기서 멈춘다.
    break;
  }

  return result;
}

/** 문자열 어디에 있든 이력번호처럼 생긴 값을 찾는 최후 폴백. */
function extractTraceNo(value: string): string | null {
  const matched = value.toUpperCase().match(TRACE_PATTERN);

  return matched ? matched[1] : null;
}

export function parseBarcode(input: string): ParsedBarcode {
  const raw = input ?? "";
  const value = raw.trim();

  const base: ParsedBarcode = {
    traceNo: null,
    weightKg: null,
    packingDate: null,
    bestBefore: null,
    lotNo: null,
    gtin: null,
    format: "unknown",
    raw,
  };

  if (!value) {
    return base;
  }

  // ① 순수 이력번호 — 전체가 딱 떨어지는 경우
  if (/^(L\d{14}|\d{15}|\d{12})$/i.test(value)) {
    return { ...base, traceNo: value.toUpperCase(), format: "plain" };
  }

  // ①-b 자체 세트번호 — 우리가 발행한 세트 박스
  if (BUNDLE_SET_PATTERN.test(value.toUpperCase())) {
    return { ...base, traceNo: value.toUpperCase(), format: "bundle" };
  }

  // ③ QR(URL) — 주소 안에서 번호를 뽑는다
  if (/^https?:\/\//i.test(value)) {
    let fromQuery: string | null = null;

    try {
      const url = new URL(value);

      for (const key of ["traceNo", "trace_no", "no", "id", "cattleNo"]) {
        const candidate = url.searchParams.get(key);

        if (candidate && /^(L\d{14}|\d{15}|\d{12})$/i.test(candidate.trim())) {
          fromQuery = candidate.trim().toUpperCase();
          break;
        }
      }
    } catch {
      // URL 파싱 실패는 아래 폴백으로 넘긴다.
    }

    return { ...base, traceNo: fromQuery ?? extractTraceNo(value), format: "url" };
  }

  // ② GS1-128
  if (looksLikeGs1(value)) {
    const parsed = parseGs1(value);
    const traceNo = parsed.traceNo ?? extractTraceNo(value);

    return {
      ...base,
      ...parsed,
      traceNo,
      format: "gs1",
    };
  }

  // 그 외 — 문자열 안에서 번호만 찾아본다
  return { ...base, traceNo: extractTraceNo(value), format: "unknown" };
}
