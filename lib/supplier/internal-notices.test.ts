import { describe, expect, it } from "vitest";
import { countUnseen, describeNotice, type InternalNotice } from "./internal-notices";

const notice = (overrides: Partial<InternalNotice> = {}): InternalNotice => ({
  id: 1,
  kind: "credit_limit",
  createdAt: "2026-10-01T03:00:00.000Z",
  actorName: "김직원",
  retailerId: "r1",
  retailerName: "식당A",
  oldValue: "100000",
  newValue: "200000",
  reason: null,
  ...overrides,
});

describe("알림함 문구", () => {
  it("여신 한도 변경은 전후 금액을 원 단위로", () => {
    expect(describeNotice(notice())).toBe("김직원 · 식당A 여신 한도 100,000원 → 200,000원");
  });

  it("금액이 비어 있으면 '-'", () => {
    expect(describeNotice(notice({ oldValue: null }))).toBe("김직원 · 식당A 여신 한도 - → 200,000원");
  });

  it("거래 정지는 사유를 붙이고, 사유가 없으면 생략", () => {
    expect(describeNotice(notice({ kind: "status", oldValue: "active", newValue: "blocked", reason: "대금 미납" }))).toBe(
      "김직원 · 식당A 거래 정지 (사유: 대금 미납)"
    );
    expect(describeNotice(notice({ kind: "status", oldValue: "active", newValue: "blocked", reason: "  " }))).toBe(
      "김직원 · 식당A 거래 정지"
    );
  });

  it("거래 재개", () => {
    expect(describeNotice(notice({ kind: "status", oldValue: "blocked", newValue: "active" }))).toBe("김직원 · 식당A 거래 재개");
  });
});

describe("안 본 알림 수", () => {
  const list = [notice({ id: 1, createdAt: "2026-10-01T03:00:00.000Z" }), notice({ id: 2, createdAt: "2026-10-01T01:00:00.000Z" })];

  it("본 적 없으면 전부", () => {
    expect(countUnseen(list, null)).toBe(2);
    expect(countUnseen(list, "not-a-date")).toBe(2);
  });

  it("마지막으로 본 시각보다 뒤의 것만", () => {
    expect(countUnseen(list, "2026-10-01T02:00:00.000Z")).toBe(1);
    expect(countUnseen(list, "2026-10-01T03:00:00.000Z")).toBe(0);
  });
});
