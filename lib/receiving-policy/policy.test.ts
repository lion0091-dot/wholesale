import { describe, expect, it } from "vitest";
import { DEFAULT_RECEIVING_POLICY, policyFromRow, validateReceivingPolicy } from "./policy";

const input = (patch: Partial<Parameters<typeof validateReceivingPolicy>[0]> = {}) => ({
  overToleranceMode: "PERCENT",
  overToleranceValue: "5",
  unlistedItemPolicy: "REJECT",
  ...patch,
});

describe("policyFromRow", () => {
  it("행이 없으면 기본값(발주 이상은 안 받음·없는 물건 거절)", () => {
    expect(policyFromRow(null)).toEqual(DEFAULT_RECEIVING_POLICY);
    expect(DEFAULT_RECEIVING_POLICY).toEqual({ overToleranceMode: "PERCENT", overToleranceValue: 0, unlistedItemPolicy: "REJECT" });
  });

  it("DB 행을 옮기고 numeric 문자열도 숫자로 읽는다", () => {
    expect(policyFromRow({ over_tolerance_mode: "KG", over_tolerance_value: "12.50", unlisted_item_policy: "HOLD" })).toEqual({
      overToleranceMode: "KG",
      overToleranceValue: 12.5,
      unlistedItemPolicy: "HOLD",
    });
  });
});

describe("validateReceivingPolicy", () => {
  it("정상 값은 통과하고 쉼표·공백을 정리하며 빈 오차는 0", () => {
    expect(validateReceivingPolicy(input())).toEqual({ ok: true, policy: { overToleranceMode: "PERCENT", overToleranceValue: 5, unlistedItemPolicy: "REJECT" } });
    expect(validateReceivingPolicy(input({ overToleranceMode: "KG", overToleranceValue: " 1,200.5 " }))).toMatchObject({ ok: true, policy: { overToleranceValue: 1200.5 } });
    expect(validateReceivingPolicy(input({ overToleranceValue: "" }))).toMatchObject({ ok: true, policy: { overToleranceValue: 0 } });
  });

  it("오차는 음수·문자·퍼센트 100 초과를 거부하고 kg은 100을 넘어도 된다", () => {
    expect(validateReceivingPolicy(input({ overToleranceValue: "-1" }))).toMatchObject({ ok: false });
    expect(validateReceivingPolicy(input({ overToleranceValue: "abc" }))).toMatchObject({ ok: false });
    expect(validateReceivingPolicy(input({ overToleranceValue: "101" }))).toMatchObject({ ok: false });
    expect(validateReceivingPolicy(input({ overToleranceMode: "KG", overToleranceValue: "500" })).ok).toBe(true);
  });

  it("단위·없는 물건 처리는 정해진 값만", () => {
    expect(validateReceivingPolicy(input({ overToleranceMode: "TON" }))).toMatchObject({ ok: false });
    expect(validateReceivingPolicy(input({ unlistedItemPolicy: "ACCEPT" }))).toMatchObject({ ok: false });
    expect(validateReceivingPolicy(input({ unlistedItemPolicy: "HOLD" })).ok).toBe(true);
  });
});
