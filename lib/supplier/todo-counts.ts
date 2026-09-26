import type { SupabaseClient } from "@supabase/supabase-js";

export type TodoKey = "newOrders" | "cancelRequests" | "needsCheckBoxes" | "openDocuments";

export type TodoCounts = Record<TodoKey, number>;

/**
 * 종 배지에 보여줄 "지금 처리할 일" 목록. 알림 기록이 아니라 현재 데이터를 세는 방식이라
 * 처리하면 숫자가 저절로 줄고 읽음 관리가 없다.
 * 링크는 PC·폰 공용 화면 하나로 통일했다(폰 전용 /dashboard/quick/* 로 갈라지지 않게).
 */
export const TODO_ITEMS: Array<{ key: TodoKey; label: string; href: string }> = [
  { key: "newOrders", label: "새 발주 (접수 대기)", href: "/dashboard/orders" },
  { key: "cancelRequests", label: "취소 요청", href: "/dashboard/orders" },
  { key: "needsCheckBoxes", label: "확인 필요 박스", href: "/dashboard/inbound" },
  { key: "openDocuments", label: "대조 중인 명세서", href: "/dashboard/inbound/statements" },
];

export function totalTodo(counts: TodoCounts): number {
  return TODO_ITEMS.reduce((sum, item) => sum + counts[item.key], 0);
}

/**
 * 로그인한 사용자 세션의 클라이언트로 부른다(RLS가 업체 범위를 한 번 더 막는다).
 * 조회 하나가 실패하면 그 항목은 0으로 둔다 — 배지가 화면을 깨뜨리면 안 된다.
 */
export async function fetchTodoCounts(supabase: SupabaseClient, wholesalerId: string): Promise<TodoCounts> {
  const head = { count: "exact", head: true } as const;

  const [newOrders, cancelRequests, needsCheckBoxes, openDocuments] = await Promise.all([
    supabase.from("orders").select("id", head).eq("wholesaler_id", wholesalerId).eq("status", "pending"),
    supabase.from("orders").select("id", head).eq("wholesaler_id", wholesalerId).eq("status", "cancel_requested"),
    supabase
      .from("inbound_scans")
      .select("id", head)
      .eq("wholesaler_id", wholesalerId)
      .in("status", ["EXCEPTION", "PENDING_MAPPING"]),
    supabase.from("inbound_documents").select("id", head).eq("wholesaler_id", wholesalerId).eq("status", "PENDING"),
  ]);

  return {
    newOrders: newOrders.count ?? 0,
    cancelRequests: cancelRequests.count ?? 0,
    needsCheckBoxes: needsCheckBoxes.count ?? 0,
    openDocuments: openDocuments.count ?? 0,
  };
}
