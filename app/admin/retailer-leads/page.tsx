import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { RetailerLeadList, type RetailerLeadRow } from "./retailer-lead-list";
import { NEXT_STEP_BUTTON_STYLE, SimpleNextStepCard } from "@/components/simple-next-step-card";
import { pickAdminLeadsNextStep } from "@/lib/admin/leads-next-step";

export default async function AdminRetailerLeadsPage() {
  const isConfigured = isSupabaseConfigured();

  if (isConfigured && !(await isSuperAdminSession())) {
    redirect("/login?next=/admin/retailer-leads");
  }

  let leads: RetailerLeadRow[] = [];

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

  const step = pickAdminLeadsNextStep(
    leads.map((lead) => ({
      id: lead.id,
      restaurantName: lead.restaurant_name,
      region: lead.region,
      desiredCategory: lead.desired_category,
      status: lead.status,
      createdAt: lead.created_at,
    }))
  );

  return (
    <div style={{ maxWidth: "768px", margin: "0 auto" }}>
      <header style={{ marginBottom: "24px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px", marginBottom: "8px" }}>
          고객(소매) 입점 희망 리드
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b" }}>
          대문에서 접수된 입점 희망 신청 목록입니다. 알고리즘 매칭이 아니라, 적합해 보이는
          공급사에 직접 연락해 의뢰하고 진행 상황을 여기 기록하는 용도입니다.
        </p>
      </header>

      <div style={{ marginBottom: "20px" }}>
        <SimpleNextStepCard
          tone={step.key === "nothing" ? "green" : "blue"}
          title={step.title}
          detail={step.detail}
          action={
            step.leadId && step.buttonLabel ? (
              <a href={`#lead-${step.leadId}`} style={NEXT_STEP_BUTTON_STYLE}>
                {step.buttonLabel}
              </a>
            ) : undefined
          }
        />
      </div>

      <RetailerLeadList initialLeads={leads} />
    </div>
  );
}
