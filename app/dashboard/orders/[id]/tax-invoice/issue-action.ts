"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import { loadStatementDataForSupplier } from "@/lib/orders/statement";
import {
  issueTaxInvoice,
  issueTaxInvoiceCorrection,
  type ModifyCode,
  type TaxInvoiceIssuanceRow,
} from "@/lib/popbill/taxinvoice";
import { PopbillNotConfiguredError } from "@/lib/popbill/client";
import type { ActionResult } from "@/app/actions/invite";

/**
 * 계산서 국세청 실제 발행/정정. 알림톡 설정과 같은 기준(owner/manager만)으로 제한한다 —
 * 실제 세무 신고 행위라 일반 staff 실수로 잘못 발행되면 되돌리기 어렵다(정정신고로만
 * 바로잡을 수 있고, 그마저도 국세청에 기록이 남는다).
 */
async function requireIssuerScope(): Promise<{ wholesalerId: string }> {
  await requireOrgRole(["owner", "manager"]);

  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    throw new Error("로그인이 필요합니다. 다시 로그인 후 시도해주세요.");
  }

  return { wholesalerId: scope.wholesalerId };
}

function toErrorResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  if (error instanceof PopbillNotConfiguredError) {
    return {
      success: false,
      error: "계산서 발행 연동이 아직 설정되지 않았습니다 (팝빌 파트너 계약 필요).",
    };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

export async function issueTaxInvoiceAction(
  orderId: string
): Promise<ActionResult<TaxInvoiceIssuanceRow>> {
  try {
    const { wholesalerId } = await requireIssuerScope();
    const supabase = await createClient();

    const statementData = await loadStatementDataForSupplier(supabase, orderId, wholesalerId);

    if (!statementData) {
      return { success: false, error: "주문을 찾을 수 없습니다." };
    }

    const row = await issueTaxInvoice(supabase, wholesalerId, orderId, statementData);

    revalidatePath(`/dashboard/orders/${orderId}`);

    return { success: true, data: row };
  } catch (error) {
    return toErrorResult(error);
  }
}

export async function issueTaxInvoiceCorrectionAction(
  orderId: string,
  originalIssuanceId: string,
  modifyCode: ModifyCode
): Promise<ActionResult<TaxInvoiceIssuanceRow>> {
  try {
    const { wholesalerId } = await requireIssuerScope();
    const supabase = await createClient();

    const statementData = await loadStatementDataForSupplier(supabase, orderId, wholesalerId);

    if (!statementData) {
      return { success: false, error: "주문을 찾을 수 없습니다." };
    }

    const row = await issueTaxInvoiceCorrection(
      supabase,
      wholesalerId,
      originalIssuanceId,
      modifyCode,
      statementData
    );

    revalidatePath(`/dashboard/orders/${orderId}`);

    return { success: true, data: row };
  } catch (error) {
    return toErrorResult(error);
  }
}

export async function listTaxInvoiceIssuancesAction(
  orderId: string
): Promise<ActionResult<TaxInvoiceIssuanceRow[]>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("tax_invoice_issuances")
      .select(
        "id, order_id, wholesaler_id, original_issuance_id, popbill_mgt_key, popbill_nts_confirm_num, status, modify_code, error_message"
      )
      .eq("order_id", orderId)
      .eq("wholesaler_id", scope.wholesalerId)
      .order("created_at", { ascending: false });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: (data ?? []) as TaxInvoiceIssuanceRow[] };
  } catch (error) {
    return toErrorResult(error);
  }
}
