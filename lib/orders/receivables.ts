/** 외상 주문의 정산 기한/연체 여부 계산 — 순수 함수 (서버/클라이언트 공용) */

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeDueAt(orderedAt: string, settlementDueDays: number): string {
  return new Date(new Date(orderedAt).getTime() + settlementDueDays * DAY_MS).toISOString();
}

export function isOverdue(dueAt: string, now: Date = new Date()): boolean {
  return new Date(dueAt).getTime() < now.getTime();
}
