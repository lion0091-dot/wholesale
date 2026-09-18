/**
 * 축산물품질평가원(KAPE) 축산물경락가격정보 API 클라이언트.
 *
 * ⚠️ 이 파일 작성 시점에는 실제 서비스키가 없어 요청/응답 형식을 data.go.kr 문서
 * 화면 기준으로만 작성했다(docs/market-price-widget.md 참고). 키가 발급되면
 * 반드시 실제 XML 응답으로 아래 항목을 재검증할 것:
 *   - 전국 두수 합계 필드명 (CTotAmt 바로 다음 열, 정확한 영문명 미확인)
 *   - startYmd/endYmd 생략 시 동작
 *   - resultCode/resultMsg, item 목록의 실제 XML 중첩 구조(response/header/body/items/item 등)
 * 위 불확실성 때문에 XML 파싱은 정확한 경로에 의존하지 않고, 파싱된 트리 전체를
 * 재귀 탐색해서 resultCode와 gradeNm이 있는 항목들을 찾는 방식으로 방어적으로 짰다.
 */

import { XMLParser } from "fast-xml-parser";

const CATTLE_ENDPOINT = "http://data.ekape.or.kr/openapi-data/service/user/grade/auct/cattle";
const PIG_ENDPOINT = "http://data.ekape.or.kr/openapi-data/service/user/grade/auct/pigGrade";

export type MarketPriceSpecies = "cattle" | "pig";

export interface MarketPriceRow {
  species: MarketPriceSpecies;
  /** 등급명 (예: "1++", "1+", "등외등급") — gradeNm 원본 그대로 */
  grade: string;
  /** 전국 평균 경락가 (원/kg) — CTotAmt */
  pricePerKg: number;
  /** 전국 두수 합계 — 필드명 미확정이라 당분간 항상 null */
  unitCount: number | null;
  /** YYYYMMDD */
  snapshotDate: string;
  /** 원본 API 오퍼레이션명 (cattle | pigGrade) */
  source: string;
}

export class KapeMarketPriceError extends Error {}

/** KAPE_MARKET_PRICE_API_KEY 설정 여부 — 미설정이면 위젯/크론 양쪽에서 조용히 스킵한다. */
export function isKapeMarketPriceConfigured(): boolean {
  return Boolean(process.env.KAPE_MARKET_PRICE_API_KEY);
}

/** 파싱된 XML 트리를 재귀 탐색해 resultCode/resultMsg를 찾는다(정확한 경로 불명이라 방어적으로 탐색). */
function findResultCode(node: unknown): { code: string | null; msg: string | null } {
  if (!node || typeof node !== "object") {
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
    if (found.code !== null) {
      return found;
    }
  }

  return { code: null, msg: null };
}

/** 파싱된 XML 트리에서 등급별 경락가 행("gradeNm" 키를 가진 노드)을 전부 수집한다. */
function collectGradeRows(node: unknown, rows: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    node.forEach((item) => collectGradeRows(item, rows));
    return rows;
  }

  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;

    if ("gradeNm" in obj) {
      rows.push(obj);
      return rows;
    }

    for (const value of Object.values(obj)) {
      collectGradeRows(value, rows);
    }
  }

  return rows;
}

async function fetchAuctionPrices(
  endpoint: string,
  species: MarketPriceSpecies,
  source: string,
  dateYmd: string,
  extraParams: Record<string, string> = {}
): Promise<MarketPriceRow[] | null> {
  const apiKey = process.env.KAPE_MARKET_PRICE_API_KEY;

  if (!apiKey) {
    return null;
  }

  const params = new URLSearchParams({
    serviceKey: apiKey,
    startYmd: dateYmd,
    endYmd: dateYmd,
    ...extraParams,
  });

  let response: Response;

  try {
    response = await fetch(`${endpoint}?${params.toString()}`);
  } catch {
    throw new KapeMarketPriceError("네트워크 오류로 축산물 경락가 API 호출에 실패했습니다.");
  }

  if (!response.ok) {
    throw new KapeMarketPriceError(`축산물 경락가 API 호출에 실패했습니다 (HTTP ${response.status}).`);
  }

  const xml = await response.text();
  const parsed = new XMLParser().parse(xml) as unknown;

  const { code, msg } = findResultCode(parsed);

  // fast-xml-parser가 숫자로 보이는 문자열("00")을 자동으로 0으로 변환하므로
  // 문자열 그대로("00") 비교하면 안 되고 수치로 비교해야 한다.
  if (code !== null && Number(code) !== 0) {
    throw new KapeMarketPriceError(msg || `축산물 경락가 API가 오류를 반환했습니다 (코드 ${code}).`);
  }

  const rows = collectGradeRows(parsed);

  return rows
    .map((row) => ({
      species,
      grade: String(row.gradeNm ?? row.gradeCd ?? "미상"),
      pricePerKg: Number(row.CTotAmt),
      unitCount: null,
      snapshotDate: dateYmd,
      source,
    }))
    .filter((row) => Number.isFinite(row.pricePerKg));
}

/** 소(한우/육우) 전국 평균 경락가 — 등급별 여러 행. */
export async function fetchCattleAuctionPrices(dateYmd: string): Promise<MarketPriceRow[] | null> {
  return fetchAuctionPrices(CATTLE_ENDPOINT, "cattle", "cattle", dateYmd);
}

/** 돼지 전국 평균 경락가 — 등급별 여러 행. */
export async function fetchPigAuctionPrices(dateYmd: string): Promise<MarketPriceRow[] | null> {
  return fetchAuctionPrices(PIG_ENDPOINT, "pig", "pigGrade", dateYmd);
}
