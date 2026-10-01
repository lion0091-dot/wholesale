import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 대시보드 알림함 항목 — "누가 거래처 여신 한도를 바꿨는지 / 거래를 정지·재개했는지".
 * 2026-10-01까지는 대표 1명에게 알림톡으로 가던 내부 통지 3종(사장님 결정으로 알림톡에서 뺌).
 * 저장소는 따로 없고 audit_log를 RPC(마이그 188)로 읽는다. 할 일이 아니라 기록이라 종 배지 숫자에는 안 섞는다.
 */
export interface InternalNotice {
  id: number;
  kind: "credit_limit" | "status";
  createdAt: string;
  actorName: string;
  retailerId: string | null;
  retailerName: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
}

export const INTERNAL_NOTICES_LIMIT = 10;

/** 알림함 항목이 누르면 가는 화면 — 거래처 관리. */
export const INTERNAL_NOTICE_HREF = "/dashboard/customers";

function formatWon(value: string | null): string {
  if (value === null || value.trim() === "") return "-";

  const amount = Number(value);

  if (!Number.isFinite(amount)) return "-";

  return `${amount.toLocaleString("ko-KR")}원`;
}

/** 패널 한 줄 문구. 예: "김직원 · 식당A 여신 한도 100,000원 → 200,000원" */
export function describeNotice(notice: InternalNotice): string {
  const who = `${notice.actorName} · ${notice.retailerName}`;

  if (notice.kind === "credit_limit") {
    return `${who} 여신 한도 ${formatWon(notice.oldValue)} → ${formatWon(notice.newValue)}`;
  }

  if (notice.newValue === "blocked") {
    const reason = notice.reason?.trim();

    return `${who} 거래 정지${reason ? ` (사유: ${reason})` : ""}`;
  }

  if (notice.newValue === "active") {
    return `${who} 거래 재개`;
  }

  return `${who} 거래 상태 변경 (${notice.oldValue ?? "-"} → ${notice.newValue ?? "-"})`;
}

/** 이 시각보다 뒤에 생긴 항목 수 — 종 옆 파란 점 표시용. seenAt이 없으면 전부 새 것. */
export function countUnseen(notices: InternalNotice[], seenAt: string | null): number {
  const seen = seenAt ? new Date(seenAt).getTime() : null;

  if (seen === null || Number.isNaN(seen)) return notices.length;

  return notices.filter((notice) => new Date(notice.createdAt).getTime() > seen).length;
}

/**
 * 로그인한 사용자 세션으로 부른다 — RPC가 대표·매니저만 통과시키고 그 외엔 빈 배열이다.
 * 조회 실패는 빈 배열로 둔다(알림함이 화면을 깨뜨리면 안 됨).
 */
export async function fetchInternalNotices(supabase: SupabaseClient, wholesalerId: string): Promise<InternalNotice[]> {
  const { data, error } = await supabase.rpc("list_wholesaler_internal_notices", {
    p_wholesaler_id: wholesalerId,
    p_limit: INTERNAL_NOTICES_LIMIT,
  });

  if (error || !Array.isArray(data)) return [];

  return (data as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    kind: row.kind === "credit_limit" ? "credit_limit" : "status",
    createdAt: String(row.created_at),
    actorName: (row.actor_name as string | null) ?? "담당자",
    retailerId: (row.retailer_id as string | null) ?? null,
    retailerName: (row.retailer_name as string | null) ?? "거래처",
    oldValue: (row.old_value as string | null) ?? null,
    newValue: (row.new_value as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
  }));
}
