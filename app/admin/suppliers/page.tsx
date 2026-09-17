import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { ensureSuperAdminBootstrap } from "@/lib/auth/super-admin-bootstrap";
import { isValidBusinessNumber } from "@/lib/validation/business-number";
import { SupplierApprovalList } from "./supplier-approval-list";
import type { Wholesaler } from "@/types/database";

/** 데모 모드(Supabase 미설정)에서 승인 UI를 시연하기 위한 샘플 공급사 */
const DEMO_SUPPLIERS: Wholesaler[] = [
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
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    updated_at: new Date().toISOString(),
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
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    updated_at: new Date().toISOString(),
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
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updated_at: new Date().toISOString(),
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

  let suppliers: Wholesaler[] = DEMO_SUPPLIERS;
  let canGrantAdmin = false;

  if (isConfigured) {
    const supabase = await createClient();

    const { data } = await supabase
      .from("wholesalers")
      .select("*")
      .order("created_at", { ascending: false });

    suppliers = (data as Wholesaler[] | null) ?? [];

    // "관리자 관리" 링크는 다른 관리자를 승격/강등할 수 있는 계정(can_grant=true)에게만 보인다.
    // /admin/admins 자체의 가드(requireAdminGranter)와 동일한 RPC로 판정한다.
    const { data: grantCheck } = await supabase.rpc("can_current_user_grant_admin");
    canGrantAdmin = Boolean(grantCheck);
  }

  const pendingCount = suppliers.filter((s) => s.status === "pending").length;
  const paidCount = suppliers.filter((s) => s.subscription_status === "active").length;
  const overdueCount = suppliers.filter((s) => s.subscription_status === "overdue").length;
  const invalidDocCount = suppliers.filter((s) => !isValidBusinessNumber(s.business_number)).length;

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "12px", color: "#dc2626", fontWeight: 700 }}>플랫폼 슈퍼 관리자</span>
          <Link href="/" style={{ fontSize: "12px", color: "#64748b", textDecoration: "underline" }}>
            ← 메인 허브로 이동
          </Link>
          {canGrantAdmin && (
            <Link
              href="/admin/admins"
              style={{ fontSize: "12px", color: "#1d4ed8", textDecoration: "underline" }}
            >
              관리자 관리 →
            </Link>
          )}
          <Link href="/admin/categories" style={{ fontSize: "12px", color: "#1d4ed8", textDecoration: "underline" }}>
            상품 카테고리 관리 →
          </Link>
        </div>
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
      <SupplierApprovalList initialSuppliers={suppliers} />
    </main>
  );
}
