"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { resolveSiteOrigin } from "@/lib/auth/supplier-auth";
import { buildBillingInvoiceMessage } from "@/lib/supplier/billing";
import { BULK_SMS_NOT_CONFIGURED_NOTICE } from "@/lib/notifications/sms-queue";
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

/**
 * 미납 청구서 전체를 문자 발송 큐(outbound_sms_queue)에 채워 넣는다. 이미 큐에 들어간
 * 청구서는 건너뛰므로(부분 유니크 인덱스 + 사전 조회) 버튼을 여러 번 눌러도 안전하다.
 * 대표 연락처(profiles.phone)가 없는 공급사는 문자를 보낼 수 없으므로 건너뛰고
 * skippedNoPhoneCount로 알려준다.
 */
export async function generateInvoiceSmsQueueAction(): Promise<
  ActionResult<{ insertedCount: number; skippedNoPhoneCount: number }>
> {
  try {
    if (!(await isSuperAdminSession())) {
      return { success: false, error: "권한이 없습니다." };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data: invoiceRows, error: invoiceError } = await supabase
      .from("platform_subscription_invoices")
      .select(
        "id, wholesaler_id, billing_month, billed_retailer_count, full_month_fee, amount, wholesalers:wholesaler_id ( business_name, representative_name, profile_id )"
      )
      .eq("status", "unpaid");

    if (invoiceError) {
      return { success: false, error: invoiceError.message ?? "청구서 조회에 실패했습니다." };
    }

    type WholesalerInfo = { business_name: string; representative_name: string; profile_id: string };

    const rows = (invoiceRows ?? []) as unknown as Array<{
      id: string;
      wholesaler_id: string;
      billing_month: string;
      billed_retailer_count: number;
      full_month_fee: number;
      amount: number;
      wholesalers: WholesalerInfo | WholesalerInfo[] | null;
    }>;

    if (rows.length === 0) {
      return { success: true, data: { insertedCount: 0, skippedNoPhoneCount: 0 } };
    }

    const { data: existing } = await supabase
      .from("outbound_sms_queue")
      .select("invoice_id")
      .eq("message_type", "billing_invoice")
      .in(
        "invoice_id",
        rows.map((row) => row.id)
      );

    const alreadyQueued = new Set(
      ((existing ?? []) as Array<{ invoice_id: string }>).map((row) => row.invoice_id)
    );

    const profileIds = Array.from(
      new Set(
        rows
          .map((row) => (Array.isArray(row.wholesalers) ? row.wholesalers[0] : row.wholesalers)?.profile_id)
          .filter((id): id is string => Boolean(id))
      )
    );

    const { data: profileRows } =
      profileIds.length > 0
        ? await supabase.from("profiles").select("id, phone").in("id", profileIds)
        : { data: [] as Array<{ id: string; phone: string | null }> };

    const phoneByProfile = new Map(
      ((profileRows ?? []) as Array<{ id: string; phone: string | null }>).map((row) => [row.id, row.phone])
    );

    const origin = await resolveSiteOrigin();

    const newRows: Array<{
      message_type: "billing_invoice";
      wholesaler_id: string;
      invoice_id: string;
      recipient_name: string;
      recipient_phone: string;
      message_body: string;
      created_by: string | null;
    }> = [];

    let skippedNoPhoneCount = 0;

    for (const row of rows) {
      if (alreadyQueued.has(row.id)) {
        continue;
      }

      const wholesaler = Array.isArray(row.wholesalers) ? row.wholesalers[0] : row.wholesalers;
      const phone = wholesaler?.profile_id ? phoneByProfile.get(wholesaler.profile_id) : null;

      if (!wholesaler || !phone) {
        skippedNoPhoneCount += 1;
        continue;
      }

      const month = Number(row.billing_month.slice(5, 7));

      newRows.push({
        message_type: "billing_invoice",
        wholesaler_id: row.wholesaler_id,
        invoice_id: row.id,
        recipient_name: wholesaler.representative_name || wholesaler.business_name,
        recipient_phone: phone,
        message_body: buildBillingInvoiceMessage({
          businessName: wholesaler.business_name,
          representativeName: wholesaler.representative_name,
          month,
          billedCount: row.billed_retailer_count,
          monthlyFee: Number(row.amount),
          fullMonthFee: Number(row.full_month_fee),
          siteOrigin: origin,
        }),
        created_by: user?.id ?? null,
      });
    }

    if (newRows.length === 0) {
      return { success: true, data: { insertedCount: 0, skippedNoPhoneCount } };
    }

    const { error: insertError } = await supabase.from("outbound_sms_queue").insert(newRows);

    if (insertError) {
      return { success: false, error: insertError.message ?? "발송 큐 생성에 실패했습니다." };
    }

    revalidatePath("/admin/billing");

    return { success: true, data: { insertedCount: newRows.length, skippedNoPhoneCount } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "발송 큐 생성 중 오류가 발생했습니다.",
    };
  }
}

/**
 * 선택한 청구서 문자 큐를 일괄발송한다 — 실제로는 아직 SMS 벤더 계약이 없어 발송하지
 * 않고 안내 문구만 반환한다(잠긴 설계 결정, 20260930000044 마이그레이션 주석 참고).
 */
export async function sendInvoiceSmsQueueAction(_ids: string[]): Promise<ActionResult> {
  if (!(await isSuperAdminSession())) {
    return { success: false, error: "권한이 없습니다." };
  }

  return { success: false, error: BULK_SMS_NOT_CONFIGURED_NOTICE };
}
