/**
 * 29단계 B — 전표 ↔ 실물 박스 사무실 대조 화면의 순수 로직.
 *
 * DB 함수(마이그레이션 118)와 값이 같아야 하는 계산은 그 SQL을 그대로 옮긴다
 * (weight-variance.ts와 같은 패턴). 화면에서 N개 줄마다 RPC를 부르지 않고
 * 서버 컴포넌트가 한 번에 읽은 데이터로 계산할 수 있게 한다.
 *
 * 스펙: docs/inbound-document-reconciliation-spec.md
 */
import { speciesMentionedIn, type TraceNumberSpecies } from "./trace-number";
import { INBOUND_WEIGHT_TOLERANCE } from "./weight-variance";

/**
 * 줄에 와야 하는 박스 수. 수량 칸이 없으면 1(번호 하나 = 박스 하나가 기본).
 * DB의 document_line_expected_qty(quantity numeric)와 같은 값을 낸다 — GREATEST(1, round(quantity)).
 */
export function documentLineExpectedQty(quantity: number | null | undefined): number {
  if (quantity === null || quantity === undefined || !Number.isFinite(quantity)) {
    return 1;
  }

  return Math.max(1, Math.round(quantity));
}

export type DocumentLineMatchStatus = "AWAITING" | "PARTIAL" | "COMPLETE" | "OVER";

/**
 * 예정 수량 대비 붙은 박스 수로 줄 상태를 판정한다.
 * DB의 document_line_match_status(line_id)와 같은 규칙 — VOIDED 박스는 이미 제외된 개수를 받는다는 전제.
 */
export function documentLineMatchStatus(expected: number, linked: number): DocumentLineMatchStatus {
  if (linked === 0) return "AWAITING";
  if (linked < expected) return "PARTIAL";
  if (linked === expected) return "COMPLETE";
  return "OVER";
}

export type CountMode = "BOXES" | "WEIGHT";

export interface LineCountInput {
  /** 줄에 고정된 판정 기준. null이면 자동 규칙. */
  countMode?: CountMode | null;
  quantity: number | null;
  labeledWeight: number | null;
  traceNo: string | null;
  rawText?: string | null;
}

const SPLIT_LINE_MARKER = /\(이력번호 \d+\/\d+\)$/;

/**
 * 줄의 판정 기준. DB의 document_line_effective_count_mode()와 같은 규칙(마이그레이션 123).
 *   표기중량이 없으면 무게로 못 세니 박스 수 · 번호를 나눈 줄은 합계가 첫 줄에만 있어 박스 수 ·
 *   개체번호(12자리) 줄은 무게 · 그 밖에는 수량이 없을 때만 무게, 수량이 있으면 박스 수.
 */
export function effectiveCountMode(line: LineCountInput): CountMode {
  if (line.labeledWeight === null || line.labeledWeight <= 0) return "BOXES";
  if (line.countMode) return line.countMode;
  if (line.rawText && SPLIT_LINE_MARKER.test(line.rawText)) return "BOXES";
  if (/^[0-9]{12}$/.test((line.traceNo ?? "").trim())) return "WEIGHT";
  if (line.quantity === null || line.quantity === undefined) return "WEIGHT";

  return "BOXES";
}

export interface LineArrival {
  mode: CountMode;
  /** BOXES: 예정 박스 수. WEIGHT: 1(환산값, 실제 기준은 expectedWeight). */
  expected: number;
  /** 이어진(취소 제외) 실제 박스 수. */
  linkedBoxes: number;
  status: DocumentLineMatchStatus;
  /** 박스를 더 받을 자리가 남았나(SQL의 linked < expected와 같은 뜻). */
  roomLeft: boolean;
  /** 아직 더 와야 하는 박스 수 — 무게 기준 줄은 덜 온 줄이면 "적어도 1박스". */
  remainingBoxes: number;
  expectedWeight: number | null;
  linkedWeight: number;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** 줄의 도착 상태. DB의 document_line_match_status()와 같은 계산 — 취소된 박스는 빼고 무게 목록을 넘긴다. */
export function lineArrival(line: LineCountInput, linkedWeights: number[]): LineArrival {
  const mode = effectiveCountMode(line);
  const linkedBoxes = linkedWeights.length;
  const linkedWeight = round3(linkedWeights.reduce((sum, weight) => sum + weight, 0));

  if (mode === "WEIGHT") {
    const target = Number(line.labeledWeight);
    let status: DocumentLineMatchStatus;

    if (linkedBoxes === 0) status = "AWAITING";
    else if (linkedWeight < round3(target * (1 - INBOUND_WEIGHT_TOLERANCE))) status = "PARTIAL";
    else if (linkedWeight <= round3(target * (1 + INBOUND_WEIGHT_TOLERANCE))) status = "COMPLETE";
    else status = "OVER";

    return {
      mode,
      expected: 1,
      linkedBoxes,
      status,
      roomLeft: status === "AWAITING" || status === "PARTIAL",
      remainingBoxes: status === "AWAITING" || status === "PARTIAL" ? 1 : 0,
      expectedWeight: target,
      linkedWeight,
    };
  }

  const expected = documentLineExpectedQty(line.quantity);
  const status = documentLineMatchStatus(expected, linkedBoxes);

  return {
    mode,
    expected,
    linkedBoxes,
    status,
    roomLeft: linkedBoxes < expected,
    remainingBoxes: Math.max(0, expected - linkedBoxes),
    expectedWeight: null,
    linkedWeight,
  };
}

/**
 * 번호 없는 줄 제안 계산에 쓰는 중량 오차 허용치(±10%). 입고 검수의 표기중량 vs 실중량
 * 허용오차(±2%, weight-variance.ts)와는 다른 값이다 — 저건 검수 통과 기준이고 이건
 * "이 박스가 이 줄 것일 가능성이 있나"를 거르는 제안용 임의값이라 더 느슨하게 잡는다.
 */
export const LINE_SUGGESTION_WEIGHT_TOLERANCE_RATIO = 0.1;

/** 품목명·부위 텍스트에서 뽑은 축종을 species_group 값(소/돼지/닭·오리) 스케일로 옮긴다. 계란은 대응 그룹이 없다. */
function speciesGroupOfMention(species: TraceNumberSpecies | null): string | null {
  switch (species) {
    case "소":
      return "소";
    case "돼지":
      return "돼지";
    case "닭":
    case "오리":
      return "닭/오리";
    default:
      return null;
  }
}

export interface SuggestionCandidateLine {
  lineId: string;
  /** 품목명 + 부위를 이어붙인 텍스트 — speciesMentionedIn 판단 재료. */
  itemText: string | null;
  /** 표기중량 합계 ÷ 예정수량 = 박스 1개당 기대 중량. 표기중량이 없으면 null(중량으로 못 거른다). */
  expectedUnitWeight: number | null;
  /**
   * 무게 기준 줄이면 아직 모자란 무게(표기중량 - 이어진 무게). 있으면 박스 1개 무게가 아니라
   * "남은 무게를 넘지 않는가"로 거른다 — 한 줄이 여러 박스로 나뉘어 와도 되기 때문이다.
   */
  remainingWeight?: number | null;
}

export interface SuggestionCandidateScan {
  weight: number;
  /** master_livestock.species_group, 없으면 parseTraceNumber에서 추론한 값(speciesGroupFromTraceNumber). */
  speciesGroup: string | null;
  /** 박스의 부위 — 이력조회의 부위, 없으면 상품의 부위. 모르면 null(부위로는 못 거른다). */
  partName?: string | null;
}

export interface LineSuggestion {
  lineId: string;
  /** true면 축종까지 맞춰서 제안, false면 축종을 몰라 중량만으로 제안(화면에 "축종 미확인" 표시). */
  speciesConfirmed: boolean;
  /** 박스의 부위가 줄 텍스트(품목명·부위)에 들어 있을 때만 true. 아닐 땐 이 키 자체가 없다. */
  partConfirmed?: true;
}

function normalizeForPartMatch(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 박스 부위가 줄의 품목명·부위 텍스트에 들어 있는가. 부위 표기가 공급처마다 달라 "안 들어 있음"이 "다른 부위"는 아니다. */
function lineMentionsPart(itemText: string | null, partName: string | null | undefined): boolean {
  const part = partName ? normalizeForPartMatch(partName) : "";

  if (!part || !itemText) return false;

  return normalizeForPartMatch(itemText).includes(part);
}

/**
 * 번호(이력번호·묶음번호)가 없는 줄에 대해, 안 붙은 박스가 후보가 될 만한지 계산한다.
 *
 * 규칙(스펙 3.3-2): 박스 실중량이 줄의 "기대 단위중량" ±10% 안에 있어야 한다. 축종을 둘 다
 * 알면(박스 species_group과 줄 텍스트의 축종 단어) 맞아야 제안하고, 하나라도 모르면 중량만으로
 * 제안하되 미확인으로 표시한다. 박스 부위가 줄 텍스트에 적힌 줄이 있으면 그 줄들로 좁힌다.
 * 자동으로 붙이는 것은 pickAutoLinkLine 조건(후보 하나 + 축종·부위 확인)일 때뿐이다(사장님 2026-09-26).
 */
export function suggestDocumentLinesForScan(
  scan: SuggestionCandidateScan,
  lines: SuggestionCandidateLine[]
): LineSuggestion[] {
  const suggestions: LineSuggestion[] = [];

  for (const line of lines) {
    if (line.remainingWeight !== undefined && line.remainingWeight !== null) {
      // 무게 기준 줄 — 남은 무게가 있고, 이 박스가 그것을 크게 넘지 않아야 한다.
      if (line.remainingWeight <= 0 || scan.weight > line.remainingWeight * (1 + INBOUND_WEIGHT_TOLERANCE)) {
        continue;
      }
    } else {
      if (line.expectedUnitWeight === null || line.expectedUnitWeight <= 0) {
        continue;
      }

      const lowerBound = line.expectedUnitWeight * (1 - LINE_SUGGESTION_WEIGHT_TOLERANCE_RATIO);
      const upperBound = line.expectedUnitWeight * (1 + LINE_SUGGESTION_WEIGHT_TOLERANCE_RATIO);

      if (scan.weight < lowerBound || scan.weight > upperBound) {
        continue;
      }
    }

    const mentioned = speciesGroupOfMention(speciesMentionedIn(line.itemText));

    if (scan.speciesGroup === null || mentioned === null) {
      suggestions.push({ lineId: line.lineId, speciesConfirmed: false });
      continue;
    }

    if (mentioned !== scan.speciesGroup) {
      continue;
    }

    suggestions.push({ lineId: line.lineId, speciesConfirmed: true });
  }

  // 박스 부위가 적힌 줄이 하나라도 있으면 그 줄들로 좁힌다. 없으면 부위 표기가 달랐을 수 있어 좁히지 않는다.
  const textByLineId = new Map(lines.map((line) => [line.lineId, line.itemText]));
  const partMatched = suggestions.filter((suggestion) =>
    lineMentionsPart(textByLineId.get(suggestion.lineId) ?? null, scan.partName)
  );

  if (partMatched.length > 0) {
    return partMatched.map((suggestion) => ({ ...suggestion, partConfirmed: true as const }));
  }

  return suggestions;
}

/**
 * 같은 번호가 여러 줄에 걸려 있을 때(한 마리를 여러 부위로 쪼갠 전표) 박스 부위가 적힌 줄이 정확히 하나면 그 줄.
 * 번호는 이미 같으니 무게·축종은 안 본다. 부위를 모르거나 적힌 줄이 없거나 여럿이면 null.
 */
export function pickLineByPart(
  lines: Array<{ lineId: string; itemText: string | null }>,
  partName: string | null | undefined
): string | null {
  const matched = lines.filter((line) => lineMentionsPart(line.itemText, partName));

  return matched.length === 1 ? matched[0].lineId : null;
}

/**
 * 후보가 정확히 하나이고 축종·부위가 모두 확인됐을 때만 그 줄을 돌려준다 — 자동으로 이어도 되는 경우.
 * 무게만 비슷한 후보나 후보가 여럿이면 null(사무실이 고른다).
 */
export function pickAutoLinkLine(suggestions: LineSuggestion[]): string | null {
  if (suggestions.length !== 1) return null;

  const only = suggestions[0];

  return only.speciesConfirmed && only.partConfirmed ? only.lineId : null;
}
