import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { computeMonthlyFee, isBillingBlocked } from "@/lib/supplier/billing";

export const metadata = {
  title: "구독 이용 제한 안내",
};

/**
 * 구독료 연체/해지/체험만료 시 middleware가 보내는 안내 화면.
 * /dashboard 밖의 독립 라우트 — /onboarding과 같은 이유(리다이렉트 루프 방지).
 */
export default async function BillingLockedPage() {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    redirect("/login?next=/billing-locked");
  }

  const supabase = await createClient();

  const [{ data: wholesaler }, { count: activeRetailerCount }] = await Promise.all([
    supabase
      .from("wholesalers")
      .select("subscription_status, trial_started_at, billing_starts_at")
      .eq("id", scope.wholesalerId)
      .maybeSingle(),
    supabase
      .from("wholesaler_retailers")
      .select("id", { count: "exact", head: true })
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("status", "active"),
  ]);

  // 관리자가 이미 상태를 되돌렸다면(결제 확인 등) 굳이 이 화면에 머물 이유가 없다.
  if (
    !wholesaler ||
    !isBillingBlocked(
      wholesaler.subscription_status,
      wholesaler.trial_started_at,
      wholesaler.billing_starts_at
    )
  ) {
    redirect("/dashboard");
  }

  const reasonText =
    wholesaler.subscription_status === "cancelled"
      ? "구독이 해지된 상태입니다."
      : wholesaler.subscription_status === "overdue"
        ? "구독료가 연체된 상태입니다."
        : "무료 체험 기간(30일)이 종료되었습니다.";

  const monthlyFee = computeMonthlyFee(activeRetailerCount ?? 0);

  return (
    <div style={{ maxWidth: "480px", margin: "80px auto", padding: "0 16px", textAlign: "center" }}>
      <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>
        구독 이용이 제한되었습니다
      </h1>
      <p style={{ fontSize: "14px", color: "#475569", marginTop: "12px", lineHeight: 1.7 }}>
        {reasonText} 백오피스 이용을 계속하려면 구독료 결제가 필요합니다.
      </p>

      <div
        style={{
          marginTop: "20px",
          padding: "16px",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          backgroundColor: "#f8fafc",
          textAlign: "left",
        }}
      >
        <div style={{ fontSize: "13px", color: "#64748b" }}>
          이번 달 구독료 (거래처 {activeRetailerCount ?? 0}곳, 구간별 누진 단가)
        </div>
        <div style={{ fontSize: "24px", fontWeight: 800, color: "#0f172a", marginTop: "4px" }}>
          {monthlyFee.toLocaleString("ko-KR")}원
        </div>
      </div>

      <p style={{ fontSize: "13px", color: "#94a3b8", marginTop: "20px", lineHeight: 1.6 }}>
        결제 안내는 플랫폼 관리자에게 문의해주세요. 결제 확인 후 이용이 즉시 재개됩니다.
      </p>
      <p style={{ fontSize: "12px", marginTop: "8px" }}>
        <a href="/#subscription" style={{ color: "#2563eb" }}>
          구간별 요금 안내 보기 →
        </a>
      </p>
    </div>
  );
}
