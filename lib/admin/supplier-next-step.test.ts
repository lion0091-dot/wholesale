import { describe, expect, it } from "vitest";
import { classifyPendingSupplier, pickAdminSupplierNextStep, type AdminSupplierRow } from "./supplier-next-step";

// 체크섬이 맞는 번호(테스트용): 1234567891, 3456789013
const OK_A = "1234567891";
const OK_B = "3456789013";

const row = (over: Partial<AdminSupplierRow>): AdminSupplierRow => ({
  id: "s1",
  businessName: "한우마을",
  status: "pending",
  profileId: "owner-1",
  businessNumber: OK_A,
  businessStartDate: "2015-03-02",
  ntsStatus: "unchecked",
  subscriptionStatus: "trial",
  createdAt: "2026-10-01T00:00:00Z",
  ...over,
});

describe("classifyPendingSupplier — 누구 차례인가", () => {
  it("번호 없음·체크섬 오류·개업일자 없음은 공급사 차례", () => {
    expect(classifyPendingSupplier(row({ businessNumber: null }), "admin")).toBe("waiting-supplier");
    expect(classifyPendingSupplier(row({ businessNumber: "1234567890" }), "admin")).toBe("waiting-supplier");
    expect(classifyPendingSupplier(row({ businessStartDate: null }), "admin")).toBe("waiting-supplier");
  });

  it("국세청 불일치·미등록은 공급사 차례(고쳐서 다시 제출해야 함)", () => {
    expect(classifyPendingSupplier(row({ ntsStatus: "mismatch" }), "admin")).toBe("waiting-supplier");
    expect(classifyPendingSupplier(row({ ntsStatus: "not_found" }), "admin")).toBe("waiting-supplier");
  });

  it("미실행·API 오류는 운영팀이 진위확인을 실행할 차례", () => {
    expect(classifyPendingSupplier(row({ ntsStatus: "unchecked" }), "admin")).toBe("verify");
    expect(classifyPendingSupplier(row({ ntsStatus: "error" }), "admin")).toBe("verify");
    expect(classifyPendingSupplier(row({ ntsStatus: null }), "admin")).toBe("verify");
  });

  it("일치면 승인할 차례, 단 본인 명의면 다른 관리자 차례", () => {
    expect(classifyPendingSupplier(row({ ntsStatus: "match" }), "admin")).toBe("approve");
    expect(classifyPendingSupplier(row({ ntsStatus: "match", profileId: "admin" }), "admin")).toBe("waiting-other-admin");
  });
});

describe("pickAdminSupplierNextStep — 카드", () => {
  it("승인할 건이 진위확인 건보다 먼저", () => {
    const step = pickAdminSupplierNextStep(
      [row({ id: "v", ntsStatus: "unchecked", createdAt: "2026-09-01T00:00:00Z" }), row({ id: "a", ntsStatus: "match", createdAt: "2026-10-01T00:00:00Z" })],
      "admin"
    );

    expect(step.key).toBe("approve");
    expect(step.supplierId).toBe("a");
  });

  it("같은 단계에서는 신청이 오래된 공급사부터", () => {
    const step = pickAdminSupplierNextStep(
      [row({ id: "new", ntsStatus: "match", createdAt: "2026-10-02T00:00:00Z" }), row({ id: "old", ntsStatus: "match", createdAt: "2026-09-20T00:00:00Z" })],
      "admin"
    );

    expect(step.supplierId).toBe("old");
    expect(step.detail).toContain("1건 더");
  });

  it("승인할 건이 없으면 진위확인, 그것도 없으면 미납", () => {
    expect(pickAdminSupplierNextStep([row({ ntsStatus: "unchecked" })], "admin").key).toBe("verify");
    expect(pickAdminSupplierNextStep([row({ status: "active", subscriptionStatus: "overdue", ntsStatus: "match" })], "admin").key).toBe("overdue");
  });

  it("본인 명의 일치 건은 승인 카드가 되지 않고 대기 안내로만 센다", () => {
    const step = pickAdminSupplierNextStep([row({ ntsStatus: "match", profileId: "admin" })], "admin");

    expect(step.key).toBe("nothing");
    expect(step.detail).toContain("다른 관리자 승인 대기 1건");
  });

  it("공급사 응답 대기만 있으면 할 일 없음 + 개수 안내", () => {
    const step = pickAdminSupplierNextStep([row({ businessNumber: null }), row({ id: "m", ntsStatus: "mismatch" })], "admin");

    expect(step.key).toBe("nothing");
    expect(step.buttonLabel).toBeNull();
    expect(step.detail).toContain("공급사 응답 대기 2건");
  });

  it("아무것도 없으면 처리됐다고 말한다", () => {
    const step = pickAdminSupplierNextStep([row({ status: "active", subscriptionStatus: "active" })], "admin");

    expect(step.key).toBe("nothing");
    expect(step.detail).toContain("모두 처리됐습니다");
  });

  it("거절·정지·종료 공급사는 신경 쓰지 않는다", () => {
    for (const status of ["rejected", "suspended", "closed"]) {
      expect(pickAdminSupplierNextStep([row({ status, ntsStatus: "match" })], "admin").key).toBe("nothing");
    }
  });

  it("승인 대기가 아닌 영업중 공급사의 진위확인 상태는 무시한다", () => {
    expect(pickAdminSupplierNextStep([row({ status: "active", ntsStatus: "unchecked" })], "admin").key).toBe("nothing");
  });

  it("두 번째 승인 건 개수와 진위확인 대기 개수가 함께 안내된다", () => {
    const step = pickAdminSupplierNextStep(
      [row({ id: "a", ntsStatus: "match", businessNumber: OK_A }), row({ id: "b", ntsStatus: "unchecked", businessNumber: OK_B })],
      "admin"
    );

    expect(step.key).toBe("approve");
    expect(step.detail).toContain("진위확인을 기다리는 건 1건");
  });
});
