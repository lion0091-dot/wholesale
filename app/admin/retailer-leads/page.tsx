import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { RetailerLeadList, type RetailerLeadRow } from "./retailer-lead-list";

const DEMO_LEADS: RetailerLeadRow[] = [
  {
    id: "demo-lead-1",
    restaurant_name: "을지로 미트하우스 (샘플)",
    contact_name: "김사장",
    contact_phone: "010-1234-5678",
    region: "서울 중구",
    desired_category: "한우",
    monthly_volume_hint: "월 200kg 내외",
    memo: "단골 도매처가 폐업해서 새로 찾는 중",
    status: "pending",
    admin_note: null,
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
  {
    id: "demo-lead-2",
    restaurant_name: "성수동 고깃집 (샘플)",
    contact_name: "박대표",
    contact_phone: "010-9876-5432",
    region: "서울 성동구",
    desired_category: "돼지고기",
    monthly_volume_hint: null,
    memo: null,
    status: "contacted",
    admin_note: "마장동 태양축산에 의뢰함 — 회신 대기",
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
  },
];

export default async function AdminRetailerLeadsPage() {
  const isConfigured = isSupabaseConfigured();

  if (isConfigured && !(await isSuperAdminSession())) {
    redirect("/login?next=/admin/retailer-leads");
  }

  let leads: RetailerLeadRow[] = DEMO_LEADS;

  if (isConfigured) {
    const supabase = await createClient();

    const { data } = await supabase
      .from("retailer_match_requests")
      .select(
        "id, restaurant_name, contact_name, contact_phone, region, desired_category, monthly_volume_hint, memo, status, admin_note, created_at"
      )
      .order("created_at", { ascending: false });

    leads = (data as RetailerLeadRow[] | null) ?? [];
  }

  const pendingCount = leads.filter((lead) => lead.status === "pending").length;

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "24px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px", marginBottom: "8px" }}>
          고객(소매) 입점 희망 리드
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b" }}>
          대문에서 접수된 입점 희망 신청 목록입니다. 알고리즘 매칭이 아니라, 적합해 보이는
          공급사에 직접 연락해 의뢰하고 진행 상황을 여기 기록하는 용도입니다.
        </p>
      </header>

      {pendingCount > 0 && (
        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            borderRadius: "10px",
            padding: "12px 16px",
            marginBottom: "20px",
            fontSize: "13px",
            color: "#92400e",
          }}
        >
          아직 연락하지 않은 신청이 <strong>{pendingCount}건</strong> 있습니다.
        </div>
      )}

      <RetailerLeadList initialLeads={leads} />
    </main>
  );
}
