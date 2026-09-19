import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { ensureSuperAdminBootstrap } from "@/lib/auth/super-admin-bootstrap";
import { isValidBusinessNumber } from "@/lib/validation/business-number";
import { countBilledRetailersForAllSuppliers, currentBillingMonthRangeUtc } from "@/lib/supplier/billed-retailers";
import {
  listActiveEventsForMonth,
  resolveDiscountForWholesaler,
  type ActiveEventDiscount,
} from "@/lib/supplier/platform-events";
import { SupplierApprovalList } from "./supplier-approval-list";
import type { Wholesaler } from "@/types/database";

export interface AdminSupplierItem extends Wholesaler {
  contactPhone?: string | null;
}

/**
 * 데모 모드(Supabase 미설정)에서 승인 UI를 시연하기 위한 샘플 공급사.
 * contactPhone은 일부러 null로 둔다 — 그럴듯한 010 번호를 채우면 "청구서 문자" 버튼이
 * 실제 배정돼 있을 수 있는 번호로 문자 앱을 여는 위험이 있다(customers/page.tsx의
 * 같은 패턴 참고). "청구 문구 복사" 버튼은 번호와 무관하게 계속 시연 가능하다.
 */
const DEMO_SUPPLIERS: AdminSupplierItem[] = [
  {
    id: "demo-wholesaler-1",
    profile_id: "profile-1",
    business_name: "마장동 태양축산 (테스트 공급사)",
    business_number: "123-45-67890",
    representative_name: "김태양",
    business_address: "서울 성동구 마장로 123, 2층",
    business_start_date: "2018-03-05",
    nts_verification_status: "match",
    nts_verified_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString(),
    business_license_path: "profile-1/business-license",
    business_license_uploaded_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString(),
    shop_token: "demo-token-12345",
    status: "active",
    subscription_status: "active",
    trial_started_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    billing_starts_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    updated_at: new Date().toISOString(),
    contactPhone: null,
  },
  {
    id: "demo-wholesaler-2",
    profile_id: "profile-2",
    business_name: "독산동 한우유통 (신규 신청)",
    business_number: "220-81-62517",
    representative_name: "박한우",
    business_address: null,
    business_start_date: null,
    nts_verification_status: "unchecked",
    nts_verified_at: null,
    business_license_path: null,
    business_license_uploaded_at: null,
    shop_token: "token-doksan-hanwoo",
    status: "pending",
    subscription_status: "trial",
    trial_started_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    billing_starts_at: null,
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    updated_at: new Date().toISOString(),
    contactPhone: null,
  },
  {
    id: "demo-wholesaler-3",
    profile_id: "profile-3",
    business_name: "가락 미트센터 (미납 업체)",
    business_number: "456-78-91011",
    representative_name: "최가락",
    business_address: "서울 송파구 가락로 45",
    business_start_date: "2015-11-20",
    nts_verification_status: "match",
    nts_verified_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 29).toISOString(),
    business_license_path: "profile-3/business-license",
    business_license_uploaded_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 29).toISOString(),
    shop_token: "token-garak-meat",
    status: "suspended",
    subscription_status: "overdue",
    trial_started_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    billing_starts_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updated_at: new Date().toISOString(),
    contactPhone: null,
  },
];

export default async function AdminSuppliersPage() {
  // 슈퍼관리자 전용 라우트. 데모 모드(Supabase 미설정)에서는 가드를 적용하지 않는다.
  const isConfigured = isSupabaseConfigured();

  if (isConfigured) {
    // SUPER_ADMIN_EMAIL 허용 계정이면 여기서 승격된다. 미들웨어(Edge)는 승격을
    // 수행할 수 없으므로, 환경변수를 나중에 설정한 경우의 최초 진입을 여기서 받는다.
    // 이미 승격된 계정은 쓰기 없이 반환하므로 매 요청 호출해도 부담이 없다.
    const bootstrap = await ensureSuperAdminBootstrap();

    // 접근 허용의 근거는 환경변수가 아니라 DB(profiles.role)다.
    if (!bootstrap.isSuperAdmin && !(await isSuperAdminSession())) {
      redirect("/login?next=/admin/suppliers");
    }
  }

  let suppliers: AdminSupplierItem[] = DEMO_SUPPLIERS;
  // 구독료(구간별 누진 단가) 계산용 — wholesaler_id → 이번 달 실발주(취소 제외) 거래처 수.
  // 데모 모드는 실제 orders 행이 없으므로 시연용 고정값을 쓴다.
  let billedRetailerCounts: Record<string, number> = {
    "demo-wholesaler-1": 12,
    "demo-wholesaler-2": 0,
    "demo-wholesaler-3": 5,
  };
  let eventDiscounts: Record<string, ActiveEventDiscount> = {};
  // wholesaler_id → 확정된 미납 청구서 합계·건수. 청구서 문자에 "이전 미납액"으로 같이 보여준다.
  let unpaidPriorInvoices: Record<string, { amount: number; count: number }> = {};

  if (isConfigured) {
    const supabase = await createClient();

    const [{ data }, billedCounts, eventsSnapshot, { data: unpaidInvoiceRows }] = await Promise.all([
      supabase
        .from("wholesalers")
        .select("*, profiles:profile_id ( phone )")
        .order("created_at", { ascending: false }),
      countBilledRetailersForAllSuppliers(supabase),
      listActiveEventsForMonth(supabase, currentBillingMonthRangeUtc()),
      supabase
        .from("platform_subscription_invoices")
        .select("wholesaler_id, amount, billing_month")
        .eq("status", "unpaid"),
    ]);

    suppliers = (((data ?? []) as Array<Wholesaler & { profiles?: { phone?: string | null } | null }>)).map((row) => ({
      ...row,
      contactPhone: row.profiles?.phone ?? null,
    }));
    billedRetailerCounts = billedCounts;
    eventDiscounts = Object.fromEntries(
      suppliers.map((supplier) => [supplier.id, resolveDiscountForWholesaler(supplier.id, eventsSnapshot)])
    );

    // 이 화면의 "청구 문구"는 이번 달 금액을 platform_subscription_invoices 행이 아니라
    // billedRetailerCounts로 그때그때 새로 계산한다(app/admin/billing/actions.ts의
    // generateInvoiceSmsQueueAction처럼 확정된 청구서 anchor id로 제외하는 게 아니라)
    // — 그래서 "이전 미납액" 합계에서도 이번 달(KST) billing_month는 직접 제외해야
    // 이중 계산을 막을 수 있다. 지금은 확정 크론이 항상 지난달 행만 만들어 이번 달
    // 미납 행이 존재하지 않지만, 그 불변식에만 기대지 않기 위한 명시적 제외다.
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const currentBillingMonthDate = `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, "0")}-01`;

    for (const row of (unpaidInvoiceRows ?? []) as Array<{
      wholesaler_id: string;
      amount: number;
      billing_month: string;
    }>) {
      if (row.billing_month === currentBillingMonthDate) {
        continue;
      }

      const current = unpaidPriorInvoices[row.wholesaler_id] ?? { amount: 0, count: 0 };
      unpaidPriorInvoices[row.wholesaler_id] = {
        amount: current.amount + Number(row.amount),
        count: current.count + 1,
      };
    }
  }

  const pendingCount = suppliers.filter((s) => s.status === "pending").length;
  const paidCount = suppliers.filter((s) => s.subscription_status === "active").length;
  const overdueCount = suppliers.filter((s) => s.subscription_status === "overdue").length;
  const invalidDocCount = suppliers.filter((s) => !isValidBusinessNumber(s.business_number)).length;

  return (
    <div style={{ maxWidth: "768px", margin: "0 auto" }}>
      <header style={{ marginBottom: "24px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px", marginBottom: "8px" }}>
          공급사 입점 승인 및 구독 거버넌스
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b" }}>
          신규 가입 공급사의 사업자등록증 진위 여부를 검증하여 입점을 승인/거절하고, 월 정기 구독(서브스크립션)
          이용 권한을 관리합니다.
        </p>
      </header>

      {/* 통계 요약 카드 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "12px",
          marginBottom: "24px",
        }}
      >
        {[
          { label: "전체 입점 공급사", value: `${suppliers.length}개소`, color: "#0f172a", labelColor: "#64748b" },
          { label: "승인 대기중", value: `${pendingCount}건`, color: "#d97706", labelColor: "#b45309" },
          { label: "유료 구독중", value: `${paidCount}개소`, color: "#16a34a", labelColor: "#166534" },
          { label: "등록번호 확인필요", value: `${invalidDocCount}건`, color: "#dc2626", labelColor: "#991b1b" },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              backgroundColor: "#ffffff",
              padding: "16px",
              borderRadius: "10px",
              border: "1px solid #e2e8f0",
              textAlign: "center",
            }}
          >
            <span style={{ fontSize: "12px", color: card.labelColor }}>{card.label}</span>
            <div style={{ fontSize: "20px", fontWeight: 800, color: card.color, marginTop: "4px" }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {overdueCount > 0 && (
        <div
          style={{
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "10px",
            padding: "12px 16px",
            marginBottom: "20px",
            fontSize: "13px",
            color: "#991b1b",
          }}
        >
          구독료 미납 공급사가 <strong>{overdueCount}개소</strong> 있습니다. 유예 기간 경과 시 이용을 일시정지하세요.
        </div>
      )}

      {/* 공급사 승인/거절 및 구독 권한 관리 목록 */}
      <SupplierApprovalList
        initialSuppliers={suppliers}
        billedRetailerCounts={billedRetailerCounts}
        eventDiscounts={eventDiscounts}
        unpaidPriorInvoices={unpaidPriorInvoices}
      />
    </div>
  );
}
