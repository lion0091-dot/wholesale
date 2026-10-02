import { describe, expect, it } from "vitest";
import { pickAdminLeadsNextStep, type AdminLeadRow } from "./leads-next-step";

const lead = (over: Partial<AdminLeadRow>): AdminLeadRow => ({
  id: "l1",
  restaurantName: "황소숯불갈비",
  region: "서울 마포구",
  desiredCategory: "한우 등심·갈비",
  status: "pending",
  createdAt: "2026-10-01T00:00:00Z",
  ...over,
});

describe("어드민 입점 리드 카드", () => {
  it("대기중이 있으면 가장 오래된 신청부터", () => {
    const step = pickAdminLeadsNextStep([lead({ id: "new", createdAt: "2026-10-02T00:00:00Z" }), lead({ id: "old", restaurantName: "돈마루", createdAt: "2026-09-20T00:00:00Z" })]);

    expect(step.key).toBe("contact");
    expect(step.leadId).toBe("old");
    expect(step.title).toContain("2건");
    expect(step.detail).toContain("돈마루");
  });

  it("지역·희망 품목이 없어도 문구가 깨지지 않는다", () => {
    expect(pickAdminLeadsNextStep([lead({ region: null, desiredCategory: null })]).detail).not.toContain("()");
  });

  it("컨택중 건수를 함께 알려 준다", () => {
    const step = pickAdminLeadsNextStep([lead({}), lead({ id: "c", status: "contacted" })]);

    expect(step.detail).toContain("컨택중인 1건");
  });

  it("대기중이 없으면 할 일 없음(컨택중이 있으면 마무리 안내)", () => {
    expect(pickAdminLeadsNextStep([]).key).toBe("nothing");
    expect(pickAdminLeadsNextStep([]).buttonLabel).toBeNull();
    expect(pickAdminLeadsNextStep([lead({ status: "matched" })]).detail).toContain("할 일이 없습니다");
    expect(pickAdminLeadsNextStep([lead({ status: "contacted" })]).detail).toContain("매칭 완료");
  });
});
