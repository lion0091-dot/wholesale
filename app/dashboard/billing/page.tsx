import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import {
  computeFeeBreakdown,
  computeMonthlyFee,
  isBillingBlocked,
  trialDaysRemaining,
} from "@/lib/supplier/billing";
import type { SubscriptionStatus } from "@/types/database";

export const metadata = {
  title: "구독료 청구서 | 도매업체 통합관리시스템",
};

/** 관리자 화면(app/admin/suppliers/supplier-approval-list.tsx)의 SUB_BADGES와 라벨/색을 맞춤. */
const STATUS_BADGES: Record<SubscriptionStatus, { label: string; bg: string; color: string }> = {
  trial: { label: "무료 체험중", bg: "#e0e7ff", color: "#3730a3" },
  active: { label: "구독 활성", bg: "#dcfce7", color: "#166534" },
  overdue: { label: "구독료 미납", bg: "#fee2e2", color: "#991b1b" },
  cancelled: { label: "구독 해지됨", bg: "#f1f5f9", color: "#64748b" },
};

function formatWon(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export default async function DashboardBillingPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let subscriptionStatus: SubscriptionStatus = "trial";
  let trialStartedAt = new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString();
  let billingStartsAt: string | null = null;
  let activeRetailerCount = 8;
  let isDemoData = true;

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: wholesaler }, { count }] = await Promise.all([
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

    if (wholesaler) {
      subscriptionStatus = wholesaler.subscription_status as SubscriptionStatus;
      trialStartedAt = wholesaler.trial_started_at as string;
      billingStartsAt = wholesaler.billing_starts_at as string | null;
      activeRetailerCount = count ?? 0;
      isDemoData = false;
    }
  }

  const monthlyFee = computeMonthlyFee(activeRetailerCount);
  const breakdown = computeFeeBreakdown(activeRetailerCount);
  const blocked = isBillingBlocked(subscriptionStatus, trialStartedAt, billingStartsAt);
  const daysLeft = subscriptionStatus === "trial" ? trialDaysRemaining(trialStartedAt) : null;
  const billingStarted = Boolean(billingStartsAt) && Date.now() >= new Date(billingStartsAt as string).getTime();
  const statusBadge = STATUS_BADGES[subscriptionStatus] ?? STATUS_BADGES.trial;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "560px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>구독료 청구서</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          거래중(active)인 거래처 수를 기준으로 매달 자동 계산되는 구간별 누진 구독료입니다.
        </p>
      </header>

      {isDemoData && (
        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
          }}
        >
          ℹ️ 연결된 공급사 계정이 없어 샘플 데이터를 표시하고 있습니다.
        </div>
      )}

      <div
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "20px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: "12px",
              fontWeight: 700,
              backgroundColor: statusBadge.bg,
              color: statusBadge.color,
              borderRadius: "6px",
              padding: "4px 9px",
            }}
          >
            {statusBadge.label}
          </span>
          {daysLeft !== null && billingStarted && (
            <span style={{ fontSize: "12px", color: daysLeft <= 7 ? "#dc2626" : "#64748b", fontWeight: 600 }}>
              체험 종료까지 {daysLeft}일
            </span>
          )}
          {blocked && (
            <span style={{ fontSize: "12px", color: "#dc2626", fontWeight: 700 }}>
              🔒 백오피스 접근 차단됨
            </span>
          )}
        </div>

        {!billingStarted ? (
          <div
            style={{
              marginTop: "16px",
              padding: "14px",
              borderRadius: "10px",
              backgroundColor: "#eff6ff",
              border: "1px solid #bfdbfe",
              color: "#1d4ed8",
              fontSize: "13px",
              lineHeight: 1.7,
            }}
          >
            아직 과금이 시작되지 않았습니다. 플랫폼 운영팀이 과금 시작일을 지정하면 그때부터
            청구됩니다 — 지금은 거래처 수와 무관하게 백오피스 접근이 제한되지 않습니다.
          </div>
        ) : (
          <>
            <div style={{ marginTop: "16px" }}>
              <div style={{ fontSize: "13px", color: "#64748b" }}>이번 달 구독료</div>
              <div style={{ fontSize: "28px", fontWeight: 800, color: "#0f172a", marginTop: "2px" }}>
                {formatWon(monthlyFee)}
              </div>
            </div>

            <div
              style={{
                marginTop: "14px",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                borderTop: "1px solid #f1f5f9",
                paddingTop: "12px",
              }}
            >
              {breakdown.map((tier) => (
                <div
                  key={tier.rangeLabel}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "12px",
                    color: "#475569",
                  }}
                >
                  <span>
                    {tier.rangeLabel} 중 {tier.count}곳 × {formatWon(tier.rate)}
                  </span>
                  <span style={{ fontWeight: 700, color: "#0f172a" }}>{formatWon(tier.subtotal)}</span>
                </div>
              ))}
              {breakdown.length === 0 && (
                <div style={{ fontSize: "12px", color: "#94a3b8" }}>거래중인 거래처가 없습니다.</div>
              )}
            </div>

            {subscriptionStatus === "trial" && (
              <p style={{ fontSize: "12px", color: "#64748b", marginTop: "12px", lineHeight: 1.6 }}>
                무료 체험 기간이라 지금은 청구되지 않습니다. 위 금액은 체험 종료 후 예상 청구액입니다.
              </p>
            )}

            {billingStartsAt && (
              <p style={{ fontSize: "12px", color: "#94a3b8", marginTop: "8px" }}>
                과금 시작일: {formatDate(billingStartsAt)}
              </p>
            )}
          </>
        )}
      </div>

      <p style={{ fontSize: "12px", color: "#94a3b8", lineHeight: 1.7 }}>
        결제는 계좌이체로 진행되며, 플랫폼 운영팀이 입금을 확인한 후 구독 상태에 반영합니다.
        결제 관련 문의는 운영팀으로 연락해주세요.
      </p>
    </div>
  );
}
