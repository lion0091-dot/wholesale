"use server";

import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { AUDIT_LOG_PAGE_SIZE } from "@/lib/audit-log/pagination";

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
  /** WHERE 조건을 통과한 전체 이력 개수 — count(*) over()라 페이지와 무관하게 모든 행에 동일하게 실려온다 */
  total_count: number;
}

const IGNORED_FIELDS = new Set(["updated_at", "created_at", "updated_by", "created_by"]);

export interface AuditLogPage<T> {
  entries: T[];
  /** 조건에 맞는 전체 이력 개수(지금까지 불러온 개수가 아니라 전체) */
  totalCount: number;
  hasMore: boolean;
}

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
 *
 * 오래 쓴 상품일수록 이력이 무한정 쌓일 수 있어 AUDIT_LOG_PAGE_SIZE개씩 끊어서
 * 가져온다. RPC가 count(*) over()로 전체 개수(total_count)를 같이 실어주므로
 * offset + 이번에 받은 개수 < totalCount 로 "더 남았는지"를 판단한다(별도 count 쿼리 불필요).
 */
export async function getRowAuditLogAction(
  tableName: "products" | "custom_prices" | "orders",
  rowId: string,
  offset = 0
): Promise<ActionResult<AuditLogPage<RowAuditEntry>>> {
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

    const entries: RowAuditEntry[] = rows.map((row) => ({
      id: row.id,
      action: row.action,
      changedByName: row.changed_by ? (nameMap.get(row.changed_by) ?? "알 수 없음") : "시스템",
      changes: diffFields(row.old_data, row.new_data),
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
