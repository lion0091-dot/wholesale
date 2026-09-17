"use server";

import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface RowAuditEntry {
  id: number;
  action: "insert" | "update" | "delete";
  changedByName: string;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  createdAt: string;
}

interface AuditLogRow {
  id: number;
  action: "insert" | "update" | "delete";
  changed_by: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
}

const IGNORED_FIELDS = new Set(["updated_at", "created_at", "updated_by", "created_by"]);

function diffFields(
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null
): Array<{ field: string; before: unknown; after: unknown }> {
  const keys = new Set([...Object.keys(oldData ?? {}), ...Object.keys(newData ?? {})]);
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];

  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;

    const before = oldData?.[key] ?? null;
    const after = newData?.[key] ?? null;

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ field: key, before, after });
    }
  }

  return changes;
}

/**
 * products/custom_prices/orders 공용 행 단위 변경 이력 조회.
 * 여러 직원이 쓰는 백오피스라 "누가" 바꿨는지 이름까지 붙여서 반환한다.
 */
export async function getRowAuditLogAction(
  tableName: "products" | "custom_prices" | "orders",
  rowId: string
): Promise<ActionResult<RowAuditEntry[]>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const supabase = await createClient();

    const [{ data, error }, { data: members }] = await Promise.all([
      supabase.rpc("get_row_audit_log", {
        p_wholesaler_id: scope.wholesalerId,
        p_table_name: tableName,
        p_row_id: rowId,
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

    const entries: RowAuditEntry[] = ((data ?? []) as AuditLogRow[]).map((row) => ({
      id: row.id,
      action: row.action,
      changedByName: row.changed_by ? (nameMap.get(row.changed_by) ?? "알 수 없음") : "시스템",
      changes: diffFields(row.old_data, row.new_data),
      createdAt: row.created_at,
    }));

    return { success: true, data: entries };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "이력 조회 중 오류가 발생했습니다.",
    };
  }
}
