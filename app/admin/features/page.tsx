import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { ensureSuperAdminBootstrap } from "@/lib/auth/super-admin-bootstrap";
import { FeatureManager, type FeatureRow } from "./feature-manager";

export const metadata = { title: "기능 관리 | 미트 파트너스" };

/**
 * 업체별 기능 켜기/끄기 — 슈퍼관리자 전용(마이그레이션 210, docs/wholesaler-features.md).
 * "기능 메뉴판"(platform_features)에 있는 기능을 업체마다 켜고 끈다. 업체 안에서 누가 쓸지는 업체 대표가 정한다.
 */
export default async function AdminFeaturesPage() {
  if (isSupabaseConfigured()) {
    const bootstrap = await ensureSuperAdminBootstrap();

    if (!bootstrap.isSuperAdmin && !(await isSuperAdminSession())) {
      redirect("/login?next=/admin/features");
    }
  }

  let rows: FeatureRow[] = [];

  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const { data } = await supabase.rpc("admin_list_wholesaler_features");

    rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      wholesalerId: String(row.wholesaler_id),
      businessName: String(row.business_name ?? ""),
      featureKey: String(row.feature_key),
      featureLabel: String(row.feature_label ?? row.feature_key),
      enabled: row.enabled === true,
      isOverride: row.is_override === true,
    }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>기능 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0", lineHeight: 1.6 }}>
          업체마다 쓰는 기능을 켜고 끕니다. 켜진 기능도 업체 안에서 누가 볼지는 그 업체 대표님이 팀원 관리에서 정합니다.
        </p>
        <p style={{ margin: "8px 0 0" }}>
          <Link href="/admin/features/history" style={{ fontSize: "13px", fontWeight: 700, color: "#1d4ed8" }}>
            켜짐·꺼짐 이력 보기 →
          </Link>
        </p>
      </header>

      <FeatureManager rows={rows} />
    </div>
  );
}
