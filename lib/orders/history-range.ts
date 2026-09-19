/** 배송완료/취소 목록을 처음 열 때 기본으로 보여주는 기간(일). null이면 전체 기간. */
export const DEFAULT_ORDER_HISTORY_DAYS = 30;

/**
 * 배송완료/취소 목록은 기간을 "전체 기간"으로 넓히면 그 자체로도 다시 수백~수천 건이
 * 될 수 있다 — 조회 구간만으로는 부족해서 한 번에 이만큼씩 끊어서 가져온다.
 */
export const ORDER_HISTORY_PAGE_SIZE = 30;

/**
 * 배송완료/취소 검색은 조회 구간(30일/3개월)에 갇히지 않고 전체 기간에서 찾아야
 * 의미가 있다 — 특정 발주번호/거래처를 찾으려는 용도라 페이지네이션 없이 상한만 둔다.
 */
export const ORDER_HISTORY_SEARCH_LIMIT = 50;

export interface HistoryRangeOption {
  days: number | null;
  label: string;
}

/** 주문 목록 화면의 조회 구간 선택지 — 배송완료/취소/전체 탭에서만 노출한다. */
export const ORDER_HISTORY_RANGE_OPTIONS: HistoryRangeOption[] = [
  { days: 30, label: "최근 30일" },
  { days: 90, label: "최근 3개월" },
  { days: null, label: "전체 기간" },
];
