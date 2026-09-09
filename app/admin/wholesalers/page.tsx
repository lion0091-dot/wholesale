import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { WholesalerApprovalList } from "./wholesaler-approval-list";
import type { Wholesaler } from "@/types/database";

export default async function AdminWholesalersPage() {
  const supabase = await createClient();

  let wholesalers: Wholesaler[] = [];

  const { data } = await supabase
    .from("wholesalers")
    .select("*")
    .order("created_at", { ascending: false });

  if (data && data.length > 0) {
    wholesalers = data as Wholesaler[];
  } else {
    // 초기 데모 및 테스트용 샘플 도매업체 목록
    wholesalers = [
      {
        id: "demo-wholesaler-1",
        profile_id: "profile-1",
        business_name: "마장동 태양축산 (테스트 도매)",
        business_number: "123-45-67890",
        representative_name: "김태양",
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
        business_number: "987-65-43210",
        representative_name: "박한우",
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
        shop_token: "token-garak-meat",
        status: "suspended",
        subscription_status: "overdue",
        created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
  }

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "8px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "12px", color: "#dc2626", fontWeight: 700 }}>플랫폼 최고 관리자</span>
              <Link
                href="/"
                style={{ fontSize: "12px", color: "#64748b", textDecoration: "underline" }}
              >
                ← 메인 허브로 이동
              </Link>
            </div>
            <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px" }}>
              도매업체 승인 및 구독 거버넌스
            </h1>
          </div>
        </div>
        <p style={{ fontSize: "13px", color: "#64748b" }}>
          신규 가입 도매업자의 사업자등록증 진위 여부를 검증하여 입점을 승인/반려하고, 월 15~20만원 SaaS 정기 구독 상태를 관리합니다.
        </p>
      </header>

      {/* 통계 요약 카드 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px", marginBottom: "24px" }}>
        <div style={{ backgroundColor: "#ffffff", padding: "16px", borderRadius: "10px", border: "1px solid #e2e8f0", textAlign: "center" }}>
          <span style={{ fontSize: "12px", color: "#64748b" }}>전체 입점 도매처</span>
          <div style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", marginTop: "4px" }}>
            {wholesalers.length}개소
          </div>
        </div>
        <div style={{ backgroundColor: "#ffffff", padding: "16px", borderRadius: "10px", border: "1px solid #e2e8f0", textAlign: "center" }}>
          <span style={{ fontSize: "12px", color: "#b45309" }}>승인 대기중</span>
          <div style={{ fontSize: "20px", fontWeight: 800, color: "#d97706", marginTop: "4px" }}>
            {wholesalers.filter((w) => w.status === "pending").length}건
          </div>
        </div>
        <div style={{ backgroundColor: "#ffffff", padding: "16px", borderRadius: "10px", border: "1px solid #e2e8f0", textAlign: "center" }}>
          <span style={{ fontSize: "12px", color: "#166534" }}>유료 구독중</span>
          <div style={{ fontSize: "20px", fontWeight: 800, color: "#16a34a", marginTop: "4px" }}>
            {wholesalers.filter((w) => w.subscription_status === "active").length}개소
          </div>
        </div>
      </div>

      {/* 도매업체 승인/구독 관리 목록 컴포넌트 */}
      <WholesalerApprovalList initialWholesalers={wholesalers} />
    </main>
  );
}
