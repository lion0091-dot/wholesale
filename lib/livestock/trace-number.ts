/**
 * 12자리 이력번호의 구조 — 첫 자리가 축종코드다(사장님 제공 표, 2026-09-24).
 *
 *   소    0  개체식별번호 12자리(개체별 번호, 세부 구조 없음)
 *   돼지  1  축종코드 1 + 농장식별번호 6 + 일련번호 5
 *   닭    2  축종코드 1 + 도축장코드 3 + 일련번호 8
 *   계란  3  축종코드 1 + 발급월일 4 + 표시의무자코드 3 + 일련번호 4
 *   오리  5  축종코드 1 + 도축장코드 3 + 일련번호 8
 *
 * 실제 번호로 확인한 것: 돼지 140077000150 → 농장 400770(공공 API 응답의 farmUniqueNo와 같다), 일련 00150.
 * 소 002191840078 → 코드 0. 오리 521060600101 → 도축장 210(조회 결과는 없었다).
 *
 * 공공 API가 축종 이름을 안 주거나(돼지는 pigNo만 온다) 결과가 비어도, 번호만으로 축종은 알 수 있다.
 * 다만 이 값은 번호에서 추론한 것이라 공용 이력 캐시(master_livestock)에 "조회된 사실"처럼 넣지 않는다 —
 * API 응답에 축종이 없을 때 축종만 보충하는 용도다(mtrace-client.ts의 toRecord).
 */

export type TraceNumberSpecies = "소" | "돼지" | "닭" | "계란" | "오리";

export interface ParsedTraceNumber {
  species: TraceNumberSpecies;
  speciesCode: string;
  /** 돼지: 농장식별번호 6자리 */
  farmCode: string | null;
  /** 닭·오리: 도축장코드 3자리 */
  slaughterhouseCode: string | null;
  /** 계란: 발급월일 4자리(MMDD) */
  issuedMonthDay: string | null;
  /** 계란: 표시의무자코드 3자리 */
  labelerCode: string | null;
  serial: string | null;
}

const SPECIES_BY_CODE: Record<string, TraceNumberSpecies> = {
  "0": "소",
  "1": "돼지",
  "2": "닭",
  "3": "계란",
  "5": "오리",
};

/** 12자리 숫자 이력번호를 축종·구성요소로 나눈다. 12자리 숫자가 아니거나 축종코드를 모르면 null. */
export function parseTraceNumber(traceNo: string | null | undefined): ParsedTraceNumber | null {
  const value = traceNo?.trim() ?? "";

  if (!/^\d{12}$/.test(value)) {
    return null;
  }

  const speciesCode = value[0];
  const species = SPECIES_BY_CODE[speciesCode];

  if (!species) {
    return null;
  }

  const base: ParsedTraceNumber = {
    species,
    speciesCode,
    farmCode: null,
    slaughterhouseCode: null,
    issuedMonthDay: null,
    labelerCode: null,
    serial: null,
  };

  switch (species) {
    case "돼지":
      return { ...base, farmCode: value.slice(1, 7), serial: value.slice(7) };
    case "닭":
    case "오리":
      return { ...base, slaughterhouseCode: value.slice(1, 4), serial: value.slice(4) };
    case "계란":
      return { ...base, issuedMonthDay: value.slice(1, 5), labelerCode: value.slice(5, 8), serial: value.slice(8) };
    default:
      return base;
  }
}

/**
 * 번호에서 추론한 축종을 상품 카테고리(products.category / product_categories)로 옮긴다.
 * 카테고리에 "닭/오리"가 한 덩어리로 있어 닭·오리는 둘 다 그쪽이고, 계란은 카테고리가 없어 null이다.
 * 닭과 오리를 카테고리로 나눌지는 사장님 결정 대기.
 */
export function speciesGroupFromTraceNumber(traceNo: string | null | undefined): string | null {
  switch (parseTraceNumber(traceNo)?.species) {
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

/**
 * 품목명·부위 글자에 축종이 "명시적으로" 적혀 있으면 그 축종을, 없거나 둘 이상이면 null.
 * 부위 이름(갈비·등심·안심·목심…)은 소·돼지가 겹쳐서 판단 근거로 쓰지 않는다 — 축종 단어만 본다.
 * 명세서의 이력번호 축종코드와 품목명이 어긋나는지 볼 때 쓴다(document-requirements.ts).
 */
export function speciesMentionedIn(text: string | null | undefined): TraceNumberSpecies | null {
  const value = text ?? "";
  const found = new Set<TraceNumberSpecies>();

  if (/한우|육우|젖소|쇠고기|소고기|우육/.test(value)) found.add("소");
  if (/돼지|돈육|한돈|양돈/.test(value)) found.add("돼지");
  if (/닭|계육|육계|삼계|치킨/.test(value)) found.add("닭");
  if (/오리(?!지널)/.test(value)) found.add("오리");
  if (/계란|달걀/.test(value)) found.add("계란");

  return found.size === 1 ? [...found][0] : null;
}

/**
 * 소 외 축종의 상품 정체성 키 중 "이력번호에서 파싱한 출처" 부분 — 돼지 농장, 닭·오리 도축장, 계란 발급월일+표시의무자.
 * 같은 공급사에서 (이 키 + 부위)가 같으면 같은 상품이다. 소·형식 밖 번호는 null(소는 별도 규칙).
 * DB의 trace_identity_key()(마이그레이션 114)와 같은 값을 만든다 — 바꾸면 양쪽을 같이 고칠 것.
 */
export function traceIdentityKey(traceNo: string | null | undefined): string | null {
  const parsed = parseTraceNumber(traceNo);

  if (!parsed) {
    return null;
  }

  switch (parsed.species) {
    case "돼지":
      return `돼지:${parsed.farmCode}`;
    case "닭":
    case "오리":
      return `${parsed.species}:${parsed.slaughterhouseCode}`;
    case "계란":
      return `계란:${parsed.issuedMonthDay}-${parsed.labelerCode}`;
    default:
      return null;
  }
}
