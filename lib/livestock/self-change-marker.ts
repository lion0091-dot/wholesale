/**
 * "방금 이 화면이 스스로 바꾼 것"을 표시하는 아주 작은 장치 — 입고 화면의 Realtime 재조회가 내 변화에 또 반응해
 * 서버를 두 번 두드리지 않게 한다(코드리뷰 2026-10-01: 박스 200개 찍으면 전체 재조회 200번이 추가로 돌았다).
 * 화면이 스스로 router.refresh()를 부르기 직전에 markSelfChange()를 찍고, Realtime 쪽은 그 직후 몇 초 안에 온 신호를 건너뛴다.
 * 브라우저 탭 하나 안에서만 의미가 있는 값이라 모듈 변수로 충분하다.
 */
let lastSelfChangeAt = 0;

export function markSelfChange(): void {
  lastSelfChangeAt = Date.now();
}

export function recentSelfChange(withinMs: number): boolean {
  return Date.now() - lastSelfChangeAt < withinMs;
}
