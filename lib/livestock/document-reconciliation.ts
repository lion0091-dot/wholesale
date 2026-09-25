/**
 * 29단계 B — 명세서 ↔ 실물 박스 사무실 대조 화면의 순수 로직.
 *
 * DB 함수(마이그레이션 118)와 값이 같아야 하는 계산은 그 SQL을 그대로 옮긴다
 * (weight-variance.ts와 같은 패턴). 화면에서 N개 줄마다 RPC를 부르지 않고
 * 서버 컴포넌트가 한 번에 읽은 데이터로 계산할 수 있게 한다.
 *
 * 스펙: docs/inbound-document-reconciliation-spec.md
 */
import { speciesMentionedIn, type TraceNumberSpecies } from "./trace-number";

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
}

export interface SuggestionCandidateScan {
  weight: number;
  /** master_livestock.species_group, 없으면 parseTraceNumber에서 추론한 값(speciesGroupFromTraceNumber). */
  speciesGroup: string | null;
}

export interface LineSuggestion {
  lineId: string;
  /** true면 축종까지 맞춰서 제안, false면 축종을 몰라 중량만으로 제안(화면에 "축종 미확인" 표시). */
  speciesConfirmed: boolean;
}

/**
 * 번호(이력번호·묶음번호)가 없는 줄에 대해, 안 붙은 박스가 후보가 될 만한지 계산한다.
 *
 * 규칙(스펙 3.3-2): 박스 실중량이 줄의 "기대 단위중량" ±10% 안에 있어야 한다. 축종을 둘 다
 * 알면(박스 species_group과 줄 텍스트의 축종 단어) 맞아야 제안하고, 하나라도 모르면 중량만으로
 * 제안하되 미확인으로 표시한다. 절대 자동으로 붙이지 않는다 — 사람이 골라야 한다(잠긴 결정).
 */
export function suggestDocumentLinesForScan(
  scan: SuggestionCandidateScan,
  lines: SuggestionCandidateLine[]
): LineSuggestion[] {
  const suggestions: LineSuggestion[] = [];

  for (const line of lines) {
    if (line.expectedUnitWeight === null || line.expectedUnitWeight <= 0) {
      continue;
    }

    const lowerBound = line.expectedUnitWeight * (1 - LINE_SUGGESTION_WEIGHT_TOLERANCE_RATIO);
    const upperBound = line.expectedUnitWeight * (1 + LINE_SUGGESTION_WEIGHT_TOLERANCE_RATIO);

    if (scan.weight < lowerBound || scan.weight > upperBound) {
      continue;
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

  return suggestions;
}
