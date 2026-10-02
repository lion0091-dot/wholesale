import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { ensureSuperAdminBootstrap } from "@/lib/auth/super-admin-bootstrap";
import { HistoryList, type PeriodRow } from "./history-list";

export const metadata = { title: "기능 켜짐·꺼짐 이력 | 미트 파트너스" };

const HISTORY_LIMIT = 500;

/**
 * 업체별 기능이 "언제부터 언제까지, 누가 켜고 껐는지" 보는 이력(마이그레이션 210, wholesaler_feature_periods).
 * 슈퍼관리자 전용. 기록은 고치거나 지울 수 없고, 청구·일할 계산이 필요해지면 이 기록을 그대로 합산한다.
 */
export default async function AdminFeatureHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (isSupabaseConfigured()) {
    const bootstrap = await ensureSuperAdminBootstrap();

    if (!bootstrap.isSuperAdmin && !(await isSuperAdminSession())) {
      redirect("/login?next=/admin/features/history");
    }
  }

  const params = await searchParams;
  const wholesalerParam = Array.isArray(params.w) ? params.w[0] : params.w;
  const wholesalerId = wholesalerParam && /^[0-9a-f-]{36}$/i.test(wholesalerParam) ? wholesalerParam : null;

  let rows: PeriodRow[] = [];

  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const { data } = await supabase.rpc("admin_list_feature_periods", {
      p_wholesaler_id: wholesalerId,
      p_key: null,
      p_limit: HISTORY_LIMIT,
    });

    rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.period_id),
      businessName: String(row.business_name ?? ""),
      featureLabel: String(row.feature_label ?? row.feature_key),
      startedAt: String(row.started_at),
      endedAt: (row.ended_at as string | null) ?? null,
      startedByName: String(row.started_by_name ?? ""),
      endedByName: (row.ended_by_name as string | null) ?? null,
    }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <Link href="/admin/features" style={{ fontSize: "12px", color: "#64748b" }}>
          ← 기능 관리로
        </Link>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: "6px 0 0" }}>기능 켜짐·꺼짐 이력</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0", lineHeight: 1.6 }}>
          업체가 어떤 기능을 언제부터 언제까지 썼는지, 누가 켜고 껐는지 보여줍니다. 한 번 기록되면 고치거나 지울 수 없습니다.
          이력은 이 기능을 도입한 날부터 쌓이고, 도입 전에는 기록이 없습니다.
          {wholesalerId ? " (한 업체만 보는 중)" : ""} 최근 {HISTORY_LIMIT}건까지 보여줍니다.
        </p>
      </header>

      <HistoryList rows={rows} />
    </div>
  );
}
