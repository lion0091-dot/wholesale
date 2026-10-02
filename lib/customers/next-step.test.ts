import { describe, expect, it } from "vitest";
import { pickCustomersNextStep, type CustomersNextStepInput } from "./next-step";

const base: CustomersNextStepInput = {
  canManage: true,
  canIssueInvite: true,
  activeCount: 3,
  pendingReviewCount: 0,
  incompleteProfileCount: 0,
  firstPendingId: null,
};

const pick = (over: Partial<CustomersNextStepInput>) => pickCustomersNextStep({ ...base, ...over });

describe("고객 관리 지금 할 일 카드 — 상태 표", () => {
  it("직원에게는 카드가 없다", () => {
    expect(pick({ canManage: false, pendingReviewCount: 2, firstPendingId: "r1" })).toBeNull();
  });

  it("승인 대기 손님이 가장 먼저, 첫 손님 검토 버튼", () => {
    const step = pick({ pendingReviewCount: 2, firstPendingId: "r1", activeCount: 0, incompleteProfileCount: 4 });

    expect(step?.key).toBe("approve-pending");
    expect(step?.title).toContain("2명");
    expect(step?.action).toEqual({ kind: "review", customerId: "r1" });
  });

  it("거래 중 고객이 없으면 첫 고객 초대(승인 전이면 승인 안내)", () => {
    expect(pick({ activeCount: 0 })?.key).toBe("invite-first");
    expect(pick({ activeCount: 0 })?.action).toEqual({ kind: "link", href: "/dashboard#invite-link" });
    expect(pick({ activeCount: 0, canIssueInvite: false })?.key).toBe("wait-approval");
  });

  it("상호·배송지가 빈 손님은 안내만(버튼 없음)", () => {
    const step = pick({ incompleteProfileCount: 2 });

    expect(step?.key).toBe("incomplete-profile");
    expect(step?.buttonLabel).toBeNull();
    expect(step?.title).toContain("2명");
  });

  it("전부 정상이면 카드가 없다", () => {
    expect(pick({})).toBeNull();
  });

  it("승인 대기 수는 있는데 대상 id가 없으면 승인 카드를 만들지 않는다(빈 버튼 방지)", () => {
    expect(pick({ pendingReviewCount: 1, firstPendingId: null })?.key).not.toBe("approve-pending");
  });
});
