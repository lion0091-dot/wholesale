"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import { computeDueAt, isOverdue } from "@/lib/orders/receivables";
import { sendReceivablesReminderToRetailer } from "@/lib/notifications/alimtalk";
import type { ActionResult } from "@/app/actions/invite";
import type { AuditLogPage } from "@/app/actions/audit-log";
import { AUDIT_LOG_PAGE_SIZE } from "@/lib/audit-log/pagination";

/**
 * 선택한 외상 주문들을 정산완료 처리한다.
 * settle_credit_orders RPC가 소유권/외상 여부/미정산 여부를 다시 검증하고,
 * 거래처별 미수금 잔액도 원자적으로 함께 차감한다 (이미 정산됐거나 소유권이 없는
 * id는 조용히 제외되고, 결과 화면은 revalidatePath 이후 최신 상태로 다시 그려진다).
 */
export async function settleCreditOrdersAction(orderIds: string[]): Promise<ActionResult> {
  try {
    if (orderIds.length === 0) {
      return { success: false, error: "정산할 발주를 선택해주세요." };
    }

    try {
      await requireOrgRole(["owner", "manager"]);
    } catch (err) {
      return { success: false, error: err instanceof RbacError ? err.message : "권한이 없습니다." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const { error } = await supabase.rpc("settle_credit_orders", {
      p_order_ids: orderIds,
    });

    if (error) {
      return { success: false, error: error.message ?? "정산 처리에 실패했습니다." };
    }

    revalidatePath("/dashboard/receivables");
    revalidatePath("/dashboard/customers");

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "정산 처리 중 오류가 발생했습니다.",
    };
  }
}

export interface ReceivableAuditEntry {
  id: number;
  action: "insert" | "update" | "delete";
  changedByName: string;
  creditLimitBefore: number | null;
  creditLimitAfter: number | null;
  outstandingBalanceBefore: number | null;
  outstandingBalanceAfter: number | null;
  statusBefore: string | null;
  statusAfter: string | null;
  createdAt: string;
}

interface AuditLogRow {
  id: number;
  action: "insert" | "update" | "delete";
  changed_by: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
  total_count: number;
}

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * 거래처의 여신(한도/미수금/상태) 변경 이력 — 여러 직원이 쓰는 백오피스라 "누가" 바꿨는지 포함.
 * AUDIT_LOG_PAGE_SIZE(10)개씩 끊어서 가져온다. RPC가 count(*) over()로 전체 개수를
 * 같이 실어주므로 offset + 이번 개수 < totalCount 로 "더 남았는지"를 판단한다.
 */
export async function getReceivableAuditLogAction(
  retailerId: string,
  offset = 0
): Promise<ActionResult<AuditLogPage<ReceivableAuditEntry>>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const [{ data, error }, { data: members }] = await Promise.all([
      supabase.rpc("get_wholesaler_retailer_audit_log", {
        p_wholesaler_id: scope.wholesalerId,
        p_retailer_id: retailerId,
        p_limit: AUDIT_LOG_PAGE_SIZE,
        p_offset: offset,
      }),
      supabase.rpc("list_wholesaler_member_names", { p_wholesaler_id: scope.wholesalerId }),
    ]);

    if (error) {
      return { success: false, error: "이력 조회에 실패했습니다." };
    }

    const nameMap = new Map(
      ((members ?? []) as Array<{ user_id: string; name: string | null }>).map((member) => [
        member.user_id,
        member.name || "이름 미등록",
      ])
    );

    const rows = (data ?? []) as AuditLogRow[];
    const totalCount = rows[0]?.total_count ?? 0;

    const entries: ReceivableAuditEntry[] = rows.map((row) => ({
      id: row.id,
      action: row.action,
      changedByName: row.changed_by ? (nameMap.get(row.changed_by) ?? "알 수 없음") : "시스템",
      creditLimitBefore: toNumberOrNull(row.old_data?.credit_limit),
      creditLimitAfter: toNumberOrNull(row.new_data?.credit_limit),
      outstandingBalanceBefore: toNumberOrNull(row.old_data?.outstanding_balance),
      outstandingBalanceAfter: toNumberOrNull(row.new_data?.outstanding_balance),
      statusBefore: (row.old_data?.status as string | undefined) ?? null,
      statusAfter: (row.new_data?.status as string | undefined) ?? null,
      createdAt: row.created_at,
    }));

    return {
      success: true,
      data: { entries, totalCount, hasMore: offset + entries.length < totalCount },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "이력 조회 중 오류가 발생했습니다.",
    };
  }
}

interface RetailerJoin {
  restaurant_name: string;
  profile_id: string;
}

/**
 * 특정 거래처에 미수금 정산 기한 리마인드 알림톡을 수동 발송한다.
 * 클라이언트가 보낸 잔액/기한을 신뢰하지 않고 DB에서 다시 조회해서 사용한다.
 */
export async function sendReceivablesReminderAction(retailerId: string): Promise<ActionResult<string>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const { data: relation } = await supabase
      .from("wholesaler_retailers")
      .select("outstanding_balance, settlement_due_days, retailers ( restaurant_name, profile_id )")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("retailer_id", retailerId)
      .maybeSingle();

    if (!relation) {
      return { success: false, error: "거래처 정보를 찾을 수 없습니다." };
    }

    const outstandingBalance = Number(relation.outstanding_balance ?? 0);

    if (outstandingBalance <= 0) {
      return { success: false, error: "미수금이 없는 거래처입니다." };
    }

    const retailer = (Array.isArray(relation.retailers) ? relation.retailers[0] : relation.retailers) as
      | RetailerJoin
      | null;

    if (!retailer) {
      return { success: false, error: "거래처 정보를 찾을 수 없습니다." };
    }

    const { data: nearestOrder } = await supabase
      .from("orders")
      .select("ordered_at")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("retailer_id", retailerId)
      .eq("payment_method", "on_credit")
      .is("settled_at", null)
      .neq("status", "cancelled")
      .order("ordered_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!nearestOrder) {
      return { success: false, error: "미정산 외상 발주가 없습니다." };
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("phone")
      .eq("id", retailer.profile_id)
      .maybeSingle();

    const nearestDueAt = computeDueAt(nearestOrder.ordered_at, relation.settlement_due_days);

    const result = await sendReceivablesReminderToRetailer({
      wholesalerId: scope.wholesalerId,
      wholesalerName: scope.businessName,
      retailerName: retailer.restaurant_name,
      retailerPhone: (profile?.phone as string | undefined) ?? undefined,
      outstandingBalance,
      nearestDueAt,
      isOverdue: isOverdue(nearestDueAt),
    });

    if (result.status === "not_configured") {
      return {
        success: false,
        error: result.error ?? "알림톡 연동이 설정되지 않았습니다. 설정 화면에서 먼저 등록해주세요.",
      };
    }

    return {
      success: result.success,
      error: result.success ? undefined : result.error ?? "알림톡 발송에 실패했습니다.",
      data: result.success ? "알림톡이 발송됐습니다." : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "리마인드 발송 중 오류가 발생했습니다.",
    };
  }
}
