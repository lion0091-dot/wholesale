/**
 * 공급처 명세서를 플랫폼 기준에 견줘 "뭐가 빠졌는지" 판정한다 (29단계 A).
 *
 * 플랫폼은 도매-소매 연결의 폐쇄형 구간만 책임진다. 공급사보다 위(상위 공급처)와의
 * 거래 방식은 플랫폼이 바꿀 수 없다 — 오는 문서를 받아서 플랫폼 양식에 맞춰 넣는
 * 것까지가 한계다. 그래서 이 모듈의 목적은 문서를 고치는 게 아니라,
 * **뭐가 모자라고 그걸 누가 채워야 하는지를 공급사에게 분명히 보여주는 것**이다.
 * (사장님 지침, 2026-09-23)
 *
 * 기준은 플랫폼이 임의로 정한 게 아니라 이미 시스템이 굴러가는 데 필요한 값들이다:
 *   - 이력번호: 축산물이력법상 거래내역 기록 + 거래명세서 PDF에 찍힌다
 *   - 상품 연결: 재고·매입·미니샵이 전부 products 기준으로 돈다
 *   - 표기중량: 저울 실중량과 대조해 오차(±2%)를 잡는다 (24단계)
 *   - 매입단가/금액: 매입 정산(/dashboard/purchases)의 근거
 *
 * 순서는 가정하지 않는다 — 명세서가 먼저 올 수도, 창고 스캔이 먼저일 수도 있다.
 * 그래서 "아직 안 들어왔다" 같은 판정은 여기서 하지 않는다.
 */

import type { DocumentLine } from "./document-parser";
import { parseTraceNumber, speciesMentionedIn } from "./trace-number";

/** 빠진 항목을 누가 채우는가 — 공급사에게 다음 행동을 알려주기 위한 구분. */
export type GapSource =
  /** 상위 공급처에 요청해서 받아야 한다 (플랫폼이 만들어줄 수 없음) */
  | "FROM_SUPPLIER"
  /** 공급사가 이 화면에서 지정하면 된다 */
  | "FROM_STAFF"
  /** 창고에서 박스를 찍으면 채워진다 */
  | "FROM_SCAN";

export type GapLevel =
  /** 없으면 플랫폼 기능(재고·매입·이력)이 성립하지 않는다 */
  | "REQUIRED"
  /** 없어도 돌아가지만 정확도가 떨어진다 */
  | "RECOMMENDED";

export interface Gap {
  code: string;
  level: GapLevel;
  source: GapSource;
  /** 화면에 그대로 띄울 한 줄. 기술 용어를 쓰지 않는다. */
  label: string;
  /** 왜 필요한지 — 공급사가 공급처에 요청할 때 근거가 된다. */
  why: string;
}

export interface LineGaps {
  lineNo: number;
  gaps: Gap[];
}

export interface DocumentGapReport {
  /** 문서 전체에 걸린 문제 */
  documentGaps: Gap[];
  /** 줄별 문제 (빠진 게 없는 줄은 들어가지 않는다) */
  lineGaps: LineGaps[];
  /** 한 항목이라도 REQUIRED가 빠진 줄 수 */
  incompleteLineCount: number;
  totalLineCount: number;
}

export interface DocumentHeaderInput {
  supplierName?: string | null;
  issuedOn?: string | null;
  totalAmount?: number | null;
}

/** 줄에 우리 상품이 연결됐는지 — 파서는 모르는 정보라 따로 받는다. */
export interface LineResolution {
  lineNo: number;
  productId?: string | null;
  /** 연결된 상품의 원산지. products.origin은 NOT NULL이라 연결되면 항상 있다. */
  productOrigin?: string | null;
}

function lineGapsFor(
  line: DocumentLine,
  resolvedProductId: string | null,
  productOrigin: string | null,
): Gap[] {
  const gaps: Gap[] = [];

  if (!line.itemName && !line.traceNo) {
    gaps.push({
      code: "ITEM_UNKNOWN",
      level: "REQUIRED",
      source: "FROM_SUPPLIER",
      label: "무슨 품목인지 적혀 있지 않습니다",
      why: "품목을 모르면 어느 상품의 재고인지 정할 수 없습니다.",
    });
  } else if (!resolvedProductId) {
    gaps.push({
      code: "PRODUCT_UNLINKED",
      level: "REQUIRED",
      source: "FROM_STAFF",
      label: "내 상품 중 어느 것인지 골라주세요",
      why: "재고와 매입 금액이 모두 상품 기준으로 쌓입니다.",
    });
  }

  if (line.labeledWeight === null) {
    gaps.push({
      code: "WEIGHT_MISSING",
      level: "REQUIRED",
      source: "FROM_SUPPLIER",
      label: "중량이 적혀 있지 않습니다",
      why: "창고 저울로 잰 무게와 맞춰봐야 모자라게 온 걸 잡아낼 수 있습니다.",
    });
  }

  // 단가와 금액 중 하나만 있어도 중량으로 나머지를 계산할 수 있다.
  if (line.unitPrice === null && line.amount === null) {
    gaps.push({
      code: "PRICE_MISSING",
      level: "REQUIRED",
      source: "FROM_SUPPLIER",
      label: "단가도 금액도 적혀 있지 않습니다",
      why: "매입 정산에서 이 물건을 얼마에 들여왔는지 계산할 수 없습니다.",
    });
  }

  if (!line.traceNo) {
    gaps.push({
      code: "TRACE_MISSING",
      level: "RECOMMENDED",
      source: "FROM_SCAN",
      label: "이력번호가 적혀 있지 않습니다",
      // 축산물이력법상 이력관리대상축산물판매업자는 거래내역서에 이력번호를
      // 기록해야 한다. 서류에 없어도 창고 스캔이 채우므로 REQUIRED는 아니지만,
      // 기록 자체는 반드시 남아야 하므로 이유를 법으로 댄다 — 공급사가 공급처에
      // 요구할 때 근거가 된다.
      why: "축산물이력법상 거래내역에는 이력번호가 남아야 합니다. 창고에서 박스를 찍으면 채워지지만, 서류에 번호가 있으면 실물과 정확히 짝지을 수 있습니다.",
    });
  }

  // 12자리 이력번호는 첫 자리가 축종코드다(소 0·돼지 1·닭 2·계란 3·오리 5 — trace-number.ts).
  // 코드가 낯설거나, 번호가 말하는 축종과 품목명의 축종이 다르면 번호를 잘못 읽었거나 품목이 어긋난 것이다.
  // 막지는 않고 짚기만 한다 — 조회는 사실, 명세서는 주장이라 불일치는 진단 신호로만 쓴다.
  const traceNo = line.traceNo?.trim() ?? "";
  const parsedTrace = parseTraceNumber(traceNo);

  if (/^\d{12}$/.test(traceNo) && !parsedTrace) {
    gaps.push({
      code: "TRACE_CODE_UNKNOWN",
      level: "RECOMMENDED",
      source: "FROM_STAFF",
      label: `이력번호 첫 자리(${traceNo[0]})가 축종코드가 아닙니다 — 번호를 다시 확인해주세요`,
      why: "12자리 이력번호의 첫 자리는 축종을 뜻합니다(소 0·돼지 1·닭 2·계란 3·오리 5). 번호를 잘못 읽었거나 이력번호가 아닌 값일 수 있습니다.",
    });
  } else if (parsedTrace) {
    const mentioned = speciesMentionedIn([line.itemName, line.partName].filter(Boolean).join(" "));

    if (mentioned && mentioned !== parsedTrace.species) {
      gaps.push({
        code: "TRACE_SPECIES_MISMATCH",
        level: "RECOMMENDED",
        source: "FROM_STAFF",
        label: `이력번호는 ${parsedTrace.species}(첫 자리 ${parsedTrace.speciesCode})인데 품목은 ${mentioned}로 읽힙니다`,
        why: "번호를 잘못 읽었거나 품목이 잘못 적혔을 수 있습니다. 이대로 두면 다른 축종의 이력이 이 품목에 붙습니다.",
      });
    }
  }

  // 등급은 그 자체로 필수가 아니다 — 이력번호가 있으면 공공조회가 채워준다.
  // 하지만 둘 다 없으면 품질을 알 길이 아예 없다. 등급은 축산물 가격을 좌우하므로
  // 그 경우에만 짚는다 (사장님 확정: "필수는 아니고 있으면 받기").
  if (!line.grade && !line.traceNo) {
    gaps.push({
      code: "GRADE_UNKNOWN",
      level: "RECOMMENDED",
      source: "FROM_SUPPLIER",
      label: "등급을 알 수 없습니다 (이력번호도 등급도 없음)",
      why: "등급은 축산물 값을 좌우합니다. 이력번호가 있으면 공공조회로 채워지지만 둘 다 없으면 확인할 방법이 없습니다.",
    });
  }

  // 원산지는 필수다(사장님 확정 2026-09-23). 알 수 있는 경로가 셋이라
  // 셋 다 막혔을 때만 걸린다 — 서류 기재 / 이력번호로 공공조회 / 연결된 상품.
  if (!line.origin && !line.traceNo && !resolvedProductId) {
    gaps.push({
      code: "ORIGIN_UNKNOWN",
      level: "REQUIRED",
      source: "FROM_SUPPLIER",
      label: "원산지를 알 수 없습니다",
      why: "원산지는 반드시 있어야 합니다. 이력번호가 있으면 공공조회로, 상품을 고르면 그 상품 기준으로 채워지지만 셋 다 없으면 확인할 방법이 없습니다.",
    });
  }

  // 서류 원산지와 고른 상품의 원산지가 다르면 상품을 잘못 고른 것이다.
  // 그대로 두면 수입육이 국내산 상품 재고로 들어가 원산지 허위표시가 된다.
  if (line.origin && productOrigin && line.origin !== productOrigin) {
    gaps.push({
      code: "ORIGIN_MISMATCH",
      level: "REQUIRED",
      source: "FROM_STAFF",
      label: `원산지가 다릅니다 — 서류는 ${line.origin}, 고른 상품은 ${productOrigin}`,
      why: "상품을 잘못 고르셨을 수 있습니다. 이대로 두면 원산지가 뒤바뀐 채 재고에 들어갑니다.",
    });
  }

  return gaps;
}

/** 줄 금액의 합. 서류에 찍힌 합계와 견줘 잘못 읽었는지 본다. */
export function sumLineAmounts(lines: DocumentLine[]): number {
  return lines.reduce((sum, line) => {
    if (line.amount !== null) return sum + line.amount;
    if (line.unitPrice !== null && line.labeledWeight !== null) {
      return sum + line.unitPrice * line.labeledWeight;
    }

    return sum;
  }, 0);
}

export function buildGapReport(
  header: DocumentHeaderInput,
  lines: DocumentLine[],
  resolutions: LineResolution[] = [],
): DocumentGapReport {
  const documentGaps: Gap[] = [];
  const resolutionByLine = new Map(resolutions.map((item) => [item.lineNo, item]));

  if (!header.supplierName?.trim()) {
    documentGaps.push({
      code: "SUPPLIER_MISSING",
      level: "REQUIRED",
      source: "FROM_STAFF",
      label: "어느 공급처에서 온 서류인지 적어주세요",
      why: "공급처별 매입 내역이 여기 기준으로 묶입니다. 다음에 같은 곳 서류를 올리면 읽는 방식도 재사용합니다.",
    });
  }

  if (!header.issuedOn) {
    documentGaps.push({
      code: "ISSUED_ON_MISSING",
      level: "RECOMMENDED",
      source: "FROM_STAFF",
      label: "서류 날짜가 비어 있습니다",
      why: "언제 들어온 물건인지 나중에 찾을 때 씁니다.",
    });
  }

  if (lines.length === 0) {
    documentGaps.push({
      code: "NO_LINES",
      level: "REQUIRED",
      source: "FROM_STAFF",
      label: "품목이 한 줄도 읽히지 않았습니다",
      why: "표에서 품목 칸과 중량 칸을 직접 짚어주시면 읽을 수 있습니다.",
    });
  }

  // 서류에 합계가 찍혀 있는데 줄 합계와 다르면 잘못 읽었을 가능성이 크다.
  // 1원 단위 반올림 차이는 무시한다.
  if (header.totalAmount !== null && header.totalAmount !== undefined && lines.length > 0) {
    const computed = sumLineAmounts(lines);

    if (Math.abs(computed - header.totalAmount) > 1) {
      documentGaps.push({
        code: "TOTAL_MISMATCH",
        level: "RECOMMENDED",
        source: "FROM_STAFF",
        label: `줄 금액을 더하면 ${Math.round(computed).toLocaleString()}원인데 서류 합계는 ${Math.round(header.totalAmount).toLocaleString()}원입니다`,
        why: "칸을 잘못 읽었거나 빠진 줄이 있을 수 있습니다. 표를 한 번 확인해주세요.",
      });
    }
  }

  const lineGaps: LineGaps[] = [];
  let incompleteLineCount = 0;

  lines.forEach((line) => {
    const resolution = resolutionByLine.get(line.lineNo);
    const gaps = lineGapsFor(
      line,
      resolution?.productId ?? null,
      resolution?.productOrigin ?? null,
    );

    if (gaps.length > 0) {
      lineGaps.push({ lineNo: line.lineNo, gaps });
    }

    if (gaps.some((gap) => gap.level === "REQUIRED")) {
      incompleteLineCount += 1;
    }
  });

  return {
    documentGaps,
    lineGaps,
    incompleteLineCount,
    totalLineCount: lines.length,
  };
}

/**
 * 공급처에 요청할 항목만 추려 한 문단으로. 공급사가 그대로 복사해
 * 공급처에 보낼 수 있게 하려는 것이다 — 플랫폼이 대신 연락할 수는 없다.
 */
export function buildSupplierRequestSummary(report: DocumentGapReport): string[] {
  const codes = new Map<string, string>();

  report.documentGaps
    .filter((gap) => gap.source === "FROM_SUPPLIER")
    .forEach((gap) => codes.set(gap.code, gap.label));

  report.lineGaps.forEach(({ gaps }) => {
    gaps
      .filter((gap) => gap.source === "FROM_SUPPLIER")
      .forEach((gap) => codes.set(gap.code, gap.label));
  });

  return [...codes.values()];
}
