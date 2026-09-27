/**
 * 입고 수용 기준 — 물건을 "어디까지 받아도 되는가"를 도매업체가 정한다(사장님 원칙 2026-09-27, 코드 고정 금지).
 * DB는 receiving_policies(마이그레이션 141). 행이 없으면 DEFAULT_RECEIVING_POLICY로 본다 — 바꾸면 양쪽을 같이 고칠 것.
 * 이 모듈은 값의 모양·검증·기본값만 다룬다. 입고 때 실제로 판정하는 곳은 DB의 judge_scan_purchase_order(마이그레이션 142)다.
 */

export type ToleranceMode = "PERCENT" | "KG";
export type UnlistedItemPolicy = "REJECT" | "HOLD";
export type OverItemPolicy = "REJECT" | "HOLD";

export interface ReceivingPolicy {
  overToleranceMode: ToleranceMode;
  overToleranceValue: number;
  overItemPolicy: OverItemPolicy;
  unlistedItemPolicy: UnlistedItemPolicy;
}

export const DEFAULT_RECEIVING_POLICY: ReceivingPolicy = {
  overToleranceMode: "PERCENT",
  overToleranceValue: 0,
  overItemPolicy: "REJECT",
  unlistedItemPolicy: "REJECT",
};

export interface ReceivingPolicyRow {
  over_tolerance_mode: string;
  over_tolerance_value: number | string;
  over_item_policy: string;
  unlisted_item_policy: string;
}

export function policyFromRow(row: ReceivingPolicyRow | null | undefined): ReceivingPolicy {
  if (!row) {
    return DEFAULT_RECEIVING_POLICY;
  }

  return {
    overToleranceMode: row.over_tolerance_mode === "KG" ? "KG" : "PERCENT",
    overToleranceValue: Number(row.over_tolerance_value) || 0,
    overItemPolicy: row.over_item_policy === "HOLD" ? "HOLD" : "REJECT",
    unlistedItemPolicy: row.unlisted_item_policy === "HOLD" ? "HOLD" : "REJECT",
  };
}

export interface ReceivingPolicyInput {
  overToleranceMode: string;
  /** 화면 입력 그대로("5", "1,200.5") — 비우면 0. */
  overToleranceValue: string;
  overItemPolicy: string;
  unlistedItemPolicy: string;
}

export type PolicyValidation = { ok: true; policy: ReceivingPolicy } | { ok: false; error: string };

export function validateReceivingPolicy(input: ReceivingPolicyInput): PolicyValidation {
  if (input.overToleranceMode !== "PERCENT" && input.overToleranceMode !== "KG") {
    return { ok: false, error: "허용 오차 단위는 퍼센트(%) 또는 킬로그램(kg) 중 하나여야 합니다." };
  }

  const text = (input.overToleranceValue ?? "").replace(/[,\s]/g, "");
  const value = text === "" ? 0 : /^\d+(\.\d+)?$/.test(text) ? Number.parseFloat(text) : Number.NaN;

  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: "허용 오차는 0 이상의 숫자로 입력해주세요." };
  }

  if (input.overToleranceMode === "PERCENT" && value > 100) {
    return { ok: false, error: "허용 오차 퍼센트는 100 이하여야 합니다." };
  }

  if (value > 99999999) {
    return { ok: false, error: "허용 오차가 너무 큽니다." };
  }

  if (input.overItemPolicy !== "REJECT" && input.overItemPolicy !== "HOLD") {
    return { ok: false, error: "발주보다 더 온 물건 처리 방식을 골라주세요." };
  }

  if (input.unlistedItemPolicy !== "REJECT" && input.unlistedItemPolicy !== "HOLD") {
    return { ok: false, error: "발주서에 없는 물건 처리 방식을 골라주세요." };
  }

  return {
    ok: true,
    policy: {
      overToleranceMode: input.overToleranceMode,
      overToleranceValue: Math.round(value * 100) / 100,
      overItemPolicy: input.overItemPolicy,
      unlistedItemPolicy: input.unlistedItemPolicy,
    },
  };
}
