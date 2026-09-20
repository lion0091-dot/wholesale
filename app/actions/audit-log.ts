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

/**
 * 도매업자가 실제로 궁금해할 사업적 의미가 있는 필드만 화이트리스트로 열거한다.
 * id/wholesaler_id 같은 식별자, pg_payment_key 같은 결제사 내부 토큰, updated_at 같은
 * 시스템 타임스탬프는 사람이 알아볼 수 없는 "전산적 데이터"라 애초에 후보에서 뺀다 —
 * 컬럼이 나중에 더 추가돼도 화이트리스트에 없으면 자동으로 숨겨지는 게 안전하다.
 *
 * custom_prices의 kind(custom/hot_deal)는 등록 시 고정되고 안 바뀌는 값이라
 * 변경 이력에 넣을 의미가 없어 제외한다 — is_active(노출 on/off)만 보여준다.
 */
export type AuditLogTable = "products" | "custom_prices" | "orders";

const FIELD_LABELS: Record<AuditLogTable, Record<string, string>> = {
  products: {
    base_price: "가격",
    unit: "단위",
    stock_quantity: "재고",
    is_active: "판매 상태",
  },
  custom_prices: {
    custom_price: "단가",
    is_active: "노출 여부",
  },
  orders: {
    status: "발주 상태",
    total_amount: "총 금액",
    delivery_address: "배송지",
    delivery_notes: "배송 메모",
    cancel_reason: "취소 사유",
    courier_code: "택배사",
    tracking_number: "운송장번호",
    payment_status: "결제 상태",
  },
};

export interface AuditLogPage<T> {
  entries: T[];
  /** 조건에 맞는 전체 이력 개수(지금까지 불러온 개수가 아니라 전체) */
  totalCount: number;
  hasMore: boolean;
}

function diffFields(
  tableName: AuditLogTable,
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null
): Array<{ field: string; before: unknown; after: unknown }> {
  const labels = FIELD_LABELS[tableName] ?? {};
  const keys = new Set([...Object.keys(oldData ?? {}), ...Object.keys(newData ?? {})]);
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];

  for (const key of keys) {
    const label = labels[key];
    if (!label) continue;

    const before = oldData?.[key] ?? null;
    const after = newData?.[key] ?? null;

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ field: label, before, after });
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
  tableName: AuditLogTable,
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
      changes: diffFields(tableName, row.old_data, row.new_data),
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
