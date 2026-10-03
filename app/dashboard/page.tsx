import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getOrgStaffContext } from "@/lib/auth/rbac";
import { CopyInviteButton } from "@/components/copy-invite-button";
import { PendingApprovalBanner } from "@/components/pending-approval-banner";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { OnboardingNextStepCard } from "@/components/onboarding-next-step-card";
import { pickOnboardingNextStep } from "@/lib/supplier/onboarding-next-step";
import {
  describeInviteRestriction,
  getSupplierAccount,
} from "@/lib/supplier/verification";
import type { OrderStatus } from "@/types/database";
import { DashboardTabs } from "./section-tabs";
import { fetchPushDevices, isAlertGap } from "@/lib/notifications/push-devices";
import { readWholesalerCredentials } from "@/lib/security/wholesaler-credentials";

interface DashboardOrder {
  id: string;
  order_number: string;
  total_amount: number;
  status: OrderStatus;
  ordered_at: string;
}

const STATUS_LABELS: Record<OrderStatus, { label: string; bg: string; color: string }> = {
  pending: { label: "신규 접수", bg: "#fef3c7", color: "#92400e" },
  awaiting_stock: { label: "확보 대기", bg: "#ffedd5", color: "#9a3412" },
  confirmed: { label: "접수 확인", bg: "#dbeafe", color: "#1e40af" },
  shipping: { label: "배송 중", bg: "#e0e7ff", color: "#3730a3" },
  delivered: { label: "배송 완료", bg: "#dcfce7", color: "#166534" },
  cancel_requested: { label: "취소 요청", bg: "#ffedd5", color: "#9a3412" },
  cancel_rejected: { label: "취소 반려", bg: "#f1f5f9", color: "#475569" },
  cancelled: { label: "주문 취소", bg: "#fee2e2", color: "#991b1b" },
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 집계 기준일은 한국 시간(KST) 자정으로 고정한다. */
function kstBoundaries() {
  const kstNow = new Date(Date.now() + KST_OFFSET_MS);
  const todayStart = new Date(
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - KST_OFFSET_MS
  );
  const monthStart = new Date(
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), 1) - KST_OFFSET_MS
  );

  return { todayStart, monthStart };
}

function formatWon(amount: number) {
  return `${Math.round(amount).toLocaleString("ko-KR")}원`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "16px 18px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

function SummaryCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent: string;
}) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>{label}</div>
      <div style={{ fontSize: "26px", fontWeight: 800, color: accent, margin: "6px 0 4px" }}>
        {value}
      </div>
      <div style={{ fontSize: "12px", color: "#94a3b8" }}>{hint}</div>
    </div>
  );
}

export default async function DashboardPage() {
  // 초대장 발부(영업) 권한은 승인 상태에 따라 달라진다.
  const [context, account] = await Promise.all([getOrgStaffContext(), getSupplierAccount()]);
  const inviteRestriction = account ? describeInviteRestriction(account) : null;
  const canIssueInvite = account?.canIssueInvite ?? false;
  const { todayStart, monthStart } = kstBoundaries();

  let businessName: string | null = null;
  let shopToken: string | null = null;
  let activeCustomerCount = 0;
  let activeProductCount = 0;
  let pendingReviewCount = 0;
  let orders: DashboardOrder[] = [];
  let hasWholesaler = false;

  if (context) {
    const supabase = await createClient();

    // 조직에 연결된 wholesalers 레코드를 찾는다 (조직 생성 전이면 profile로 직접 조회).
    let wholesalerId: string | null = null;
    let wholesaler: { id: string; business_name: string | null; shop_token: string | null } | null =
      null;

    if (!context.isSuperAdmin) {
      // 일반 공급사: getSupplierAccount()가 같은 규칙(조직 연결 업체 → 본인 소유 업체)으로
      // 이미 같은 행을 읽었으므로 재조회하지 않는다. wholesalerId는 행이 실제로 있을 때만 채워진다.
      wholesaler = account?.wholesalerId
        ? { id: account.wholesalerId, business_name: account.businessName, shop_token: account.shopToken }
        : null;
    } else {
      if (context.organizationId) {
        const { data: organization } = await supabase
          .from("organizations")
          .select("wholesaler_id")
          .eq("id", context.organizationId)
          .maybeSingle();

        wholesalerId = (organization?.wholesaler_id as string | null) ?? null;
      }

      // super_admin은 조직 소속(wholesalerId)이 없는 한 자기 profile_id로 업체를 자동
      // 매칭하지 않는다 (lib/supplier/scope.ts의 getSupplierScope()와 동일한 방어).
      // getSupplierAccount()는 이 방어가 없어서 여기서는 그 결과를 쓰지 않는다.
      if (wholesalerId) {
        const { data } = await supabase
          .from("wholesalers")
          .select("id, business_name, shop_token")
          .eq("id", wholesalerId)
          .maybeSingle();

        wholesaler = data;
      }
    }

    if (wholesaler) {
      hasWholesaler = true;
      wholesalerId = wholesaler.id as string;
      businessName = (wholesaler.business_name as string) ?? businessName;
      shopToken = (wholesaler.shop_token as string) ?? shopToken;

      const [{ data: monthOrders }, { count: customerCount }, { count: productCount }, { count: waitingCount }] =
        await Promise.all([
          supabase
            .from("orders")
            .select("id, order_number, total_amount, status, ordered_at")
            .eq("wholesaler_id", wholesalerId)
            .gte("ordered_at", monthStart.toISOString())
            .order("ordered_at", { ascending: false }),
          supabase
            .from("wholesaler_retailers")
            .select("id", { count: "exact", head: true })
            .eq("wholesaler_id", wholesalerId)
            .eq("status", "active"),
          supabase
            .from("products")
            .select("id", { count: "exact", head: true })
            .eq("wholesaler_id", wholesalerId)
            .eq("is_active", true),
          supabase
            .from("wholesaler_retailers")
            .select("id", { count: "exact", head: true })
            .eq("wholesaler_id", wholesalerId)
            .eq("status", "pending_review"),
        ]);

      activeCustomerCount = customerCount ?? 0;
      activeProductCount = productCount ?? 0;
      pendingReviewCount = waitingCount ?? 0;
      orders = (monthOrders ?? []) as DashboardOrder[];
    }
  }

  if (!hasWholesaler && context?.isSuperAdmin) {
    return <AdminScopeNotice />;
  }

  const todayOrders = orders.filter((order) => new Date(order.ordered_at) >= todayStart);
  const todaySales = todayOrders
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + Number(order.total_amount), 0);
  const monthSales = orders
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + Number(order.total_amount), 0);
  const pendingCount = orders.filter((order) => order.status === "pending").length;
  const recentOrders = orders.slice(0, 5);

  // 가입 → 승인 → 첫 고객 초대까지 이끄는 "지금 할 일" 카드(대표·매니저에게만). 카드가 있으면 아래 승인 배너는 겹치므로 숨긴다.
  const canManageSupplier =
    Boolean(account?.isWholesalerOwner) || context?.orgRole === "owner" || context?.orgRole === "manager";
  const onboardingStep =
    account && hasWholesaler && !context?.isSuperAdmin
      ? pickOnboardingNextStep({
          supplierStatus: account.supplierStatus,
          isVerified: account.isVerified,
          businessNumber: account.businessNumber,
          businessStartDate: account.businessStartDate,
          ntsStatus: account.ntsVerificationStatus,
          hasLicense: Boolean(account.businessLicensePath),
          activeCustomerCount,
          pendingReviewCount,
          canManage: canManageSupplier,
        })
      : null;

  // 알림톡 폴백을 끈 업체에서 알림을 켠 기기가 하나도 없으면 새 주문 알림이 어디로도 안 간다 — 대표·매니저에게 경고한다.
  // 기기가 있으면 폴백 설정은 읽지 않는다(대부분의 방문은 DB 조회 1번만 더 든다).
  let alertGap = false;

  const alertWholesalerId = account?.wholesalerId ?? null;

  if (hasWholesaler && alertWholesalerId && canManageSupplier && !context?.isSuperAdmin) {
    const devices = await fetchPushDevices(await createClient());

    if (devices !== null && devices.length === 0) {
      const { data } = await readWholesalerCredentials(alertWholesalerId, "alimtalk_fallback_enabled");

      alertGap = isAlertGap(data?.alimtalk_fallback_enabled !== false, devices);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <DashboardTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>
          {businessName ? `${businessName} ` : ""}대시보드
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          오늘의 주문 현황과 매출 요약을 확인하고, 고객(소매) 전용 미니샵 초대 링크를
          전달하세요.
        </p>
      </header>

      <OnboardingNextStepCard step={onboardingStep} />

      {alertGap && (
        <Link
          href="/dashboard/invites"
          role="alert"
          style={{ display: "block", textDecoration: "none", color: "#991b1b", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "12px", padding: "12px 16px", fontSize: "13px", fontWeight: 700, lineHeight: 1.6 }}
        >
          새 주문 알림이 어디로도 가지 않습니다 — 알림을 켠 기기가 없고 알림톡도 꺼져 있어요. 눌러서 [설정]에서 알림을 켜거나 알림톡 안전망을 다시 켜세요 →
        </Link>
      )}

      <section className="dash-cards">
        <SummaryCard
          label="오늘의 주문 건수"
          value={`${todayOrders.length}건`}
          hint={`처리 대기(신규 접수) ${pendingCount}건`}
          accent="#dc2626"
        />
        <SummaryCard
          label="오늘 매출"
          value={formatWon(todaySales)}
          hint="취소 주문 제외 · KST 기준"
          accent="#0f172a"
        />
        <SummaryCard
          label="이번 달 매출"
          value={formatWon(monthSales)}
          hint={`누적 주문 ${orders.length}건`}
          accent="#2563eb"
        />
      </section>

      {!onboardingStep && account && !canIssueInvite && inviteRestriction && (
        <PendingApprovalBanner message={inviteRestriction} showInviteLink />
      )}

      <section id="invite-link" style={{ ...cardStyle, scrollMarginTop: "12px" }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>
          미니샵 초대 링크
        </div>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6, marginBottom: "12px" }}>
          카카오톡으로 전달할 초대 문구와 전용 주문 링크를 한 번에 복사합니다. 링크를 받은
          고객(소매)만 내 미니샵과 단가를 볼 수 있습니다.
        </p>
        <CopyInviteButton
          canIssue={canIssueInvite}
          restrictionMessage={inviteRestriction}
          shopToken={canIssueInvite ? (account?.shopToken ?? shopToken) : null}
        />
      </section>

      <section className="dash-cards">
        <SummaryCard
          label="거래 중인 고객(소매)"
          value={`${activeCustomerCount}곳`}
          hint="초대 수락 후 거래 활성 상태"
          accent="#0f172a"
        />
        <SummaryCard
          label="판매 중인 상품"
          value={`${activeProductCount}개`}
          hint="미니샵에 노출되는 활성 상품"
          accent="#0f172a"
        />
      </section>

      <section style={cardStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "12px",
          }}
        >
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>최근 주문</div>
          <Link href="/dashboard/orders" style={{ fontSize: "12px", color: "#2563eb" }}>
            전체 보기 →
          </Link>
        </div>

        {recentOrders.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8" }}>이번 달 접수된 주문서가 없습니다.</p>
        ) : (
          <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" }}>
            {recentOrders.map((order) => {
              const status = STATUS_LABELS[order.status] ?? STATUS_LABELS.pending;

              return (
                <li
                  key={order.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "10px 12px",
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      backgroundColor: status.bg,
                      color: status.color,
                      borderRadius: "4px",
                      padding: "3px 7px",
                    }}
                  >
                    {status.label}
                  </span>
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a" }}>
                    {order.order_number}
                  </span>
                  <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                    {formatTime(order.ordered_at)}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "#0f172a",
                    }}
                  >
                    {formatWon(Number(order.total_amount))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
