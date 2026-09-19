"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import type { ActionResult } from "@/app/actions/invite";

type InvoiceStatus = "paid" | "unpaid";

/** 확정된 청구서 하나의 수납 상태 변경(완납/미납 토글). 화면에서 직접 처리할 때 쓴다. */
export async function markInvoiceStatusAction(
  invoiceId: string,
  status: InvoiceStatus
): Promise<ActionResult> {
  try {
    if (!(await isSuperAdminSession())) {
      return { success: false, error: "권한이 없습니다." };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { error } = await supabase
      .from("platform_subscription_invoices")
      .update({
        status,
        paid_at: status === "paid" ? new Date().toISOString() : null,
        collected_by: status === "paid" ? (user?.id ?? null) : null,
      })
      .eq("id", invoiceId);

    if (error) {
      return { success: false, error: error.message ?? "처리에 실패했습니다." };
    }

    revalidatePath("/admin/billing");

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.",
    };
  }
}

export interface BulkInvoiceStatusUpdate {
  invoiceId: string;
  status: InvoiceStatus;
}

/** 엑셀(CSV) 업로드로 여러 청구서의 수납 상태를 한 번에 반영. */
export async function bulkUpdateInvoiceStatusAction(
  updates: BulkInvoiceStatusUpdate[]
): Promise<ActionResult<{ updatedCount: number; failedIds: string[] }>> {
  try {
    if (!(await isSuperAdminSession())) {
      return { success: false, error: "권한이 없습니다." };
    }

    if (updates.length === 0) {
      return { success: false, error: "반영할 행이 없습니다." };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const failedIds: string[] = [];
    let updatedCount = 0;

    // 행마다 완납/미납이 섞여 있을 수 있어 한 번의 UPDATE로 묶을 수 없다 —
    // 업로드 규모(공급사 수)가 크지 않을 것으로 보고 순차 처리한다.
    for (const update of updates) {
      const { error } = await supabase
        .from("platform_subscription_invoices")
        .update({
          status: update.status,
          paid_at: update.status === "paid" ? new Date().toISOString() : null,
          collected_by: update.status === "paid" ? (user?.id ?? null) : null,
        })
        .eq("id", update.invoiceId);

      if (error) {
        failedIds.push(update.invoiceId);
      } else {
        updatedCount += 1;
      }
    }

    revalidatePath("/admin/billing");

    return { success: true, data: { updatedCount, failedIds } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "일괄 반영 중 오류가 발생했습니다.",
    };
  }
}

export interface ReconcileInvoiceMatch {
  invoiceId: string;
  /** 은행 거래내역 대사 근거(입금일·입금자명·금액 등)를 memo에 그대로 남긴다. */
  note: string;
}

/** 은행 거래내역 CSV 대사 결과를 완납으로 일괄 반영. memo에 매칭 근거를 남겨 추적 가능하게 한다. */
export async function reconcileInvoicePaymentsAction(
  matches: ReconcileInvoiceMatch[]
): Promise<ActionResult<{ updatedCount: number; failedIds: string[] }>> {
  try {
    if (!(await isSuperAdminSession())) {
      return { success: false, error: "권한이 없습니다." };
    }

    if (matches.length === 0) {
      return { success: false, error: "반영할 매칭 결과가 없습니다." };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const failedIds: string[] = [];
    let updatedCount = 0;

    for (const match of matches) {
      const { error } = await supabase
        .from("platform_subscription_invoices")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          collected_by: user?.id ?? null,
          memo: match.note,
        })
        .eq("id", match.invoiceId)
        .eq("status", "unpaid");

      if (error) {
        failedIds.push(match.invoiceId);
      } else {
        updatedCount += 1;
      }
    }

    revalidatePath("/admin/billing");

    return { success: true, data: { updatedCount, failedIds } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "대사 반영 중 오류가 발생했습니다.",
    };
  }
}
