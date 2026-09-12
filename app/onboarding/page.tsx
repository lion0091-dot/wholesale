import Link from "next/link";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isDevOrgBypassEnabled } from "@/lib/auth/dev-mode";
import {
  PENDING_VERIFICATION_NOTICE,
  getSupplierAccount,
} from "@/lib/supplier/verification";
import { PendingApprovalBanner } from "@/components/pending-approval-banner";
import { DevOrgLinkPanel, OrganizationCreateForm } from "./onboarding-form";
import { SupplierSignupForm } from "./supplier-signup-form";

export const metadata = {
  title: "공급사 가입 완료 | 온보딩",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "20px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

const demoNoticeStyle: React.CSSProperties = {
  backgroundColor: "#fef3c7",
  border: "1px solid #fde68a",
  color: "#92400e",
  fontSize: "13px",
  padding: "12px 16px",
  borderRadius: "8px",
  lineHeight: 1.6,
};

/**
 * 공급사 온보딩.
 *
 * 1단계(최소 정보): 카카오 가입 직후 — 필수 약관 동의 + 연락처 + 상호.
 *                   제출 즉시 미니샵 토큰과 조직 스코프가 생성되어 바로 사용 시작.
 * 2단계(조직 생성): 1단계 이전에 만들어진 레거시 계정(조직 미소속) 전용 경로.
 */
export default async function OnboardingPage() {
  const supabaseConfigured = isSupabaseConfigured();
  const account = supabaseConfigured ? await getSupplierAccount() : null;

  // 인증이 동작하는 환경인데 세션이 없으면 로그인부터 (미들웨어와 동일한 기준)
  if (supabaseConfigured && !account) {
    redirect("/login?next=/onboarding");
  }

  // 바이어(구매 회원)는 백오피스 온보딩 대상이 아니다.
  if (account?.platformRole === "retailer") {
    redirect("/");
  }

  const needsMinimumInfo = account?.needsMinimumInfo ?? false;

  // 최소 정보 + 조직까지 모두 갖춘 계정은 이 화면에 머무를 이유가 없다.
  if (account && !needsMinimumInfo && account.organizationId) {
    redirect("/dashboard");
  }

  // 프로덕션에서는 개발 안내 박스를 아예 트리에서 제외한다(여백까지 제거).
  const isProduction = process.env.NODE_ENV === "production";
  const showDevPanel = !isProduction && isDevOrgBypassEnabled() && !needsMinimumInfo;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a" }}>
          {needsMinimumInfo ? "가입 마무리 (약관 동의 + 최소 정보)" : "판매자 조직 설정"}
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "6px", lineHeight: 1.7 }}>
          {needsMinimumInfo ? (
            <>
              카카오 로그인이 완료되었습니다. 아래 항목만 입력하면{" "}
              <strong>관리자 승인을 기다리지 않고</strong> 상품 등록과 발주 관리를 바로 시작할 수
              있습니다.
            </>
          ) : (
            <>
              이 계정은 아직 소속된 공급사 조직이 없습니다. 조직을 만들면 상품·단가·발주 데이터가
              조직 단위로 분리되어 관리되고, 직원을 초대할 수 있습니다.
            </>
          )}
          {account?.email && (
            <>
              <br />
              <span style={{ color: "#94a3b8" }}>로그인 계정: {account.email}</span>
            </>
          )}
        </p>
      </header>

      {!supabaseConfigured && (
        <div style={demoNoticeStyle}>
          ℹ️ Supabase 환경변수가 설정되지 않은 데모 모드입니다. 가입/조직 생성은 동작하지 않으며,
          백오피스는 샘플 데이터로 열람할 수 있습니다.
        </div>
      )}

      {account?.isSuperAdmin && (
        <div
          style={{
            backgroundColor: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e40af",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
            lineHeight: 1.6,
          }}
        >
          플랫폼 슈퍼관리자는 조직 소속 없이도 백오피스를 감독 열람할 수 있습니다.{" "}
          <Link href="/admin/suppliers" style={{ fontWeight: 700, color: "#1d4ed8" }}>
            공급사 심사 콘솔로 이동 →
          </Link>
        </div>
      )}

      {needsMinimumInfo ? (
        <>
          <PendingApprovalBanner
            message={PENDING_VERIFICATION_NOTICE}
            detail="사업자등록번호는 지금 입력하지 않아도 가입이 완료됩니다."
          />

          <section style={cardStyle}>
            <div
              style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "14px" }}
            >
              공급사 기본 정보
            </div>
            <SupplierSignupForm
              defaultName={account?.name ?? null}
              defaultPhone={account?.phone || null}
            />
          </section>
        </>
      ) : (
        <>
          {showDevPanel ? (
            <section style={{ ...cardStyle, borderColor: "#bfdbfe", backgroundColor: "#f8fbff" }}>
              <div
                style={{ fontSize: "14px", fontWeight: 700, color: "#1e40af", marginBottom: "6px" }}
              >
                개발/테스트 모드
              </div>
              <p
                style={{
                  fontSize: "13px",
                  color: "#475569",
                  lineHeight: 1.6,
                  marginBottom: "12px",
                }}
              >
                조직 가드가 개발 환경에서 우회되어 있어 조직 없이도 백오피스에 진입할 수 있습니다.
                테스트 데이터를 조직 스코프로 쓰려면 아래에서 기본 테스트 조직에 연결하세요.
                (프로덕션 빌드에서는 이 우회가 자동으로 비활성화됩니다.)
              </p>

              <DevOrgLinkPanel />

              <div style={{ marginTop: "10px" }}>
                <Link
                  href="/dashboard/products"
                  style={{ fontSize: "13px", fontWeight: 600, color: "#2563eb" }}
                >
                  조직 연결 없이 상품 관리로 이동 →
                </Link>
              </div>
            </section>
          ) : null}

          <section style={cardStyle}>
            <div
              style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "14px" }}
            >
              새 조직 만들기
            </div>
            <OrganizationCreateForm />
          </section>
        </>
      )}
    </div>
  );
}
