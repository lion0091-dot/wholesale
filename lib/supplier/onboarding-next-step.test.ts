import { describe, expect, it } from "vitest";
import { ONBOARDING_PATHS, pickOnboardingNextStep, type OnboardingNextStepInput } from "./onboarding-next-step";

const base: OnboardingNextStepInput = {
  supplierStatus: "pending",
  isVerified: false,
  businessNumber: null,
  businessStartDate: null,
  ntsStatus: "unchecked",
  hasLicense: false,
  activeCustomerCount: 0,
  pendingReviewCount: 0,
  canManage: true,
};

const pick = (over: Partial<OnboardingNextStepInput>) => pickOnboardingNextStep({ ...base, ...over });

describe("공급사 지금 할 일 카드 — 상태 표", () => {
  it("직원(관리 권한 없음)에게는 아무것도 안 보인다", () => {
    expect(pick({ canManage: false })).toBeNull();
  });

  it("종료·업체 없음은 카드가 없다", () => {
    expect(pick({ supplierStatus: "closed" })).toBeNull();
    expect(pick({ supplierStatus: null })).toBeNull();
  });

  it("거절이 가장 먼저", () => {
    expect(pick({ supplierStatus: "rejected", businessNumber: "1234567891" })?.key).toBe("rejected");
  });

  it("일시정지는 버튼 없이 안내만", () => {
    const step = pick({ supplierStatus: "suspended" });

    expect(step?.key).toBe("suspended");
    expect(step?.button).toBeNull();
  });

  it("미승인: 번호 없음 → 개업일자 없음 → 국세청 불일치 → 심사 중 순서", () => {
    expect(pick({})?.key).toBe("submit-number");
    expect(pick({ businessNumber: "1234567891" })?.key).toBe("submit-start-date");
    expect(pick({ businessNumber: "1234567891", businessStartDate: "2015-03-02", ntsStatus: "mismatch" })?.key).toBe("fix-business-info");
    expect(pick({ businessNumber: "1234567891", businessStartDate: "2015-03-02", ntsStatus: "not_found" })?.key).toBe("fix-business-info");
    expect(pick({ businessNumber: "1234567891", businessStartDate: "2015-03-02", ntsStatus: "unchecked" })?.key).toBe("under-review");
    expect(pick({ businessNumber: "1234567891", businessStartDate: "2015-03-02", ntsStatus: "match" })?.key).toBe("under-review");
  });

  it("국세청 API 오류(error)는 공급사 잘못이 아니라 심사 중으로 본다", () => {
    expect(pick({ businessNumber: "1234567891", businessStartDate: "2015-03-02", ntsStatus: "error" })?.key).toBe("under-review");
  });

  it("심사 중: 사본이 없으면 올리기 버튼, 있으면 버튼 없이 기다림", () => {
    const filled = { businessNumber: "1234567891", businessStartDate: "2015-03-02" };

    expect(pick({ ...filled, hasLicense: false })?.button?.href).toBe(ONBOARDING_PATHS.businessLicense);
    expect(pick({ ...filled, hasLicense: true })?.button).toBeNull();
  });

  it("미승인이어도 불일치가 심사 중보다 먼저 보인다(공급사가 고칠 수 있는 일이 먼저)", () => {
    expect(pick({ businessNumber: "1234567891", businessStartDate: "2015-03-02", ntsStatus: "mismatch", hasLicense: true })?.key).toBe("fix-business-info");
  });

  it("승인 후: 승인 대기 손님 → 첫 고객 초대 → 카드 없음", () => {
    const approved = { supplierStatus: "active" as const, isVerified: true, businessNumber: "1234567891", businessStartDate: "2015-03-02", ntsStatus: "match" };

    expect(pick({ ...approved, pendingReviewCount: 2, activeCustomerCount: 0 })?.key).toBe("pending-customers");
    expect(pick({ ...approved, pendingReviewCount: 2, activeCustomerCount: 3 })?.key).toBe("pending-customers");
    expect(pick({ ...approved, activeCustomerCount: 0 })?.key).toBe("invite-first-customer");
    expect(pick({ ...approved, activeCustomerCount: 1 })).toBeNull();
  });

  it("상태는 active인데 승인 플래그가 없으면 아직 미승인으로 본다", () => {
    expect(pick({ supplierStatus: "active", isVerified: false, businessNumber: "1234567891", businessStartDate: "2015-03-02" })?.key).toBe("under-review");
  });

  it("승인 대기 손님 수가 제목에 들어간다", () => {
    expect(pick({ supplierStatus: "active", isVerified: true, pendingReviewCount: 3 })?.title).toContain("3명");
  });

  it("모든 카드의 버튼은 정해진 경로만 가리킨다", () => {
    const paths = new Set<string>(Object.values(ONBOARDING_PATHS));
    const inputs: Array<Partial<OnboardingNextStepInput>> = [
      {},
      { businessNumber: "1234567891" },
      { businessNumber: "1234567891", businessStartDate: "2015-03-02", ntsStatus: "mismatch" },
      { businessNumber: "1234567891", businessStartDate: "2015-03-02" },
      { supplierStatus: "rejected" },
      { supplierStatus: "active", isVerified: true, pendingReviewCount: 1 },
      { supplierStatus: "active", isVerified: true },
    ];

    for (const input of inputs) {
      const step = pick(input);

      if (step?.button) expect(paths.has(step.button.href), `${step.key}: ${step.button.href}`).toBe(true);
    }
  });
});
