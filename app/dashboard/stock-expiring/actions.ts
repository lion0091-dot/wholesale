"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface DisposeBoxResult {
  success: boolean;
  error?: string;
  /** 손실 금액(원). 박스 매입단가를 모르면 null */
  lossAmount?: number | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_CODES = ["EXPIRED", "DAMAGE", "SPOILED", "OTHER"];

const ERRORS: Record<string, string> = {
  NOT_OWNER: "박스 폐기는 대표님만 할 수 있습니다.",
  STALE: "화면을 연 사이에 남은 양이 바뀌었습니다. 새로 고친 뒤 다시 확인해 주세요.",
  OVER_REMAINING: "남은 양보다 많이는 폐기할 수 없습니다.",
  INVALID_WEIGHT: "버릴 중량을 0보다 크게, 소수 셋째 자리까지로 입력해 주세요.",
  INVALID_REASON: "폐기 사유를 골라 주세요.",
  NOTE_REQUIRED: "기타 사유는 메모를 2자 이상 적어 주세요.",
  NOTE_TOO_LONG: "메모는 200자 이내로 적어 주세요.",
  BOX_NOT_NORMAL: "재고로 잡힌 박스만 폐기할 수 있습니다.",
  NO_PRODUCT: "상품이 정해지지 않은 박스는 폐기할 수 없습니다.",
  NO_LEDGER: "입출고 기록이 없는 오래된 박스라 이 화면에서는 폐기할 수 없습니다.",
  TARGET_NOT_FOUND: "박스를 찾을 수 없습니다.",
};

/**
 * 박스를 일부 또는 전량 폐기한다(마이그레이션 216). 대표만 가능하고 DB 함수가 한 번 더 막는다.
 * 화면이 본 남은 양(expectedRemaining)이 그 사이 바뀌었으면 STALE로 거부한다.
 */
export async function disposeBoxAction(input: {
  boxId: string;
  weight: number;
  reasonCode: string;
  note: string;
  expectedRemaining: number;
}): Promise<DisposeBoxResult> {
  if (!UUID_PATTERN.test(input.boxId) || !REASON_CODES.includes(input.reasonCode)) {
    return { success: false, error: "요청이 올바르지 않습니다." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dispose_box", {
    p_box_id: input.boxId,
    p_weight: input.weight,
    p_reason_code: input.reasonCode,
    p_note: input.note,
    p_expected_remaining: input.expectedRemaining,
  });

  if (error) {
    const code = Object.keys(ERRORS).find((key) => error.message.includes(key));

    return { success: false, error: code ? ERRORS[code] : "폐기하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }

  revalidatePath("/dashboard/stock-expiring");
  revalidatePath("/dashboard/stock-boxes");
  revalidatePath("/dashboard/stock-valuation");
  revalidatePath("/dashboard/stock-integrity");

  const loss = (data as { loss_amount?: number | string | null } | null)?.loss_amount;

  return { success: true, lossAmount: loss === null || loss === undefined ? null : Number(loss) };
}
