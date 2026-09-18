"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import type { ActionResult } from "@/app/actions/invite";

const VALID_STATUSES = ["pending", "contacted", "matched", "closed"];

/** 리드 상태 변경 + 관리자 메모 저장. 슈퍼관리자 전용(RLS도 동일 기준). */
export async function updateRetailerMatchRequestAction(
  requestId: string,
  status: string,
  adminNote: string
): Promise<ActionResult> {
  try {
    if (!(await isSuperAdminSession())) {
      return { success: false, error: "권한이 없습니다." };
    }

    if (!VALID_STATUSES.includes(status)) {
      return { success: false, error: "올바르지 않은 상태입니다." };
    }

    const supabase = await createClient();

    const { error } = await supabase
      .from("retailer_match_requests")
      .update({ status, admin_note: adminNote.trim() || null, updated_at: new Date().toISOString() })
      .eq("id", requestId);

    if (error) {
      return { success: false, error: error.message ?? "저장에 실패했습니다." };
    }

    revalidatePath("/admin/retailer-leads");

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "저장 중 오류가 발생했습니다.",
    };
  }
}
