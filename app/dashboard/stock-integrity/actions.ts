"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { fetchStockMovements, type MovementRow } from "@/lib/supplier/stock-repair";

export interface RepairActionResult {
  success: boolean;
  error?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERRORS: Record<string, string> = {
  NOT_OWNER: "장부 불일치 보정은 대표님만 할 수 있습니다.",
  STALE: "화면을 연 사이에 숫자가 바뀌었습니다. 새로 고친 뒤 다시 확인해 주세요.",
  NOT_MISMATCHED: "이미 장부와 맞는 항목입니다.",
  REASON_REQUIRED: "사유를 2자 이상 적어 주세요.",
  INVALID_ACTUAL: "실물 수량을 0 이상의 숫자로 입력해 주세요.",
  ACTUAL_OVER_WEIGHT: "이 박스의 입고 중량보다 많은 수량으로는 맞출 수 없습니다.",
  ACTUAL_BELOW_BOXES: "남은 박스 합계보다 적게는 상품 재고를 맞출 수 없습니다. 박스별로 보정해 주세요.",
  LEDGER_OUT_OF_RANGE: "장부 값이 이 박스의 입고 중량 범위를 벗어납니다. 실물 기준으로 보정해 주세요.",
  NO_LEDGER: "장부 기록이 없는 항목이라 이 화면에서는 고칠 수 없습니다.",
  NO_PRODUCT: "상품이 정해지지 않은 박스는 고칠 수 없습니다.",
  TARGET_NOT_FOUND: "대상을 찾을 수 없습니다.",
  INVALID_KIND: "요청이 올바르지 않습니다.",
  INVALID_BASIS: "요청이 올바르지 않습니다.",
};

/**
 * 어긋난 상품 재고·박스 잔량을 "장부 기준" 또는 "실물 기준"으로 보정한다(마이그레이션 215).
 * 대표만 가능하고 DB 함수가 한 번 더 막는다. 화면이 본 값(expectedCurrent·expectedLedger)이 그 사이 바뀌었으면 STALE로 거부한다.
 */
export async function repairStockMismatchAction(input: {
  kind: "product" | "box";
  targetId: string;
  basis: "LEDGER" | "ACTUAL";
  actual: number | null;
  reason: string;
  expectedCurrent: number;
  expectedLedger: number;
}): Promise<RepairActionResult> {
  if (!UUID_PATTERN.test(input.targetId) || (input.kind !== "product" && input.kind !== "box")) {
    return { success: false, error: ERRORS.INVALID_KIND };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("repair_stock_mismatch", {
    p_kind: input.kind,
    p_id: input.targetId,
    p_basis: input.basis,
    p_actual: input.basis === "ACTUAL" ? input.actual : null,
    p_reason: input.reason,
    p_expected_current: input.expectedCurrent,
    p_expected_ledger: input.expectedLedger,
  });

  if (error) {
    const code = Object.keys(ERRORS).find((key) => error.message.includes(key));

    return { success: false, error: code ? ERRORS[code] : "보정하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }

  revalidatePath("/dashboard/stock-integrity");
  revalidatePath("/dashboard/stock-boxes");
  revalidatePath("/dashboard/stock-valuation");

  return { success: true };
}

export interface MovementsResult {
  success: boolean;
  error?: string;
  movements?: MovementRow[];
}

/** 어긋난 항목을 열 때 그 박스·상품의 입출고 기록을 불러온다(근거 확인용). 대표만 — DB 함수가 막는다. */
export async function loadStockMovementsAction(kind: "product" | "box", targetId: string): Promise<MovementsResult> {
  if (!UUID_PATTERN.test(targetId) || (kind !== "product" && kind !== "box")) {
    return { success: false, error: "요청이 올바르지 않습니다." };
  }

  const movements = await fetchStockMovements(await createClient(), kind, targetId);

  if (!movements) {
    return { success: false, error: "입출고 기록을 불러오지 못했습니다." };
  }

  return { success: true, movements };
}
