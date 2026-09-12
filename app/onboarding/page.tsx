import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrgStaffContext } from "@/lib/auth/rbac";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isDevOrgBypassEnabled } from "@/lib/auth/dev-mode";
import { DevOrgLinkPanel, OrganizationCreateForm } from "./onboarding-form";

export const metadata = {
  title: "공급사 조직 설정 | 온보딩",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "20px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

export default async function OnboardingPage() {
  const context = await getOrgStaffContext();
  const supabaseConfigured = isSupabaseConfigured();

  // 인증이 동작하는 환경인데 세션이 없으면 로그인부터 (미들웨어와 동일한 기준)
  if (supabaseConfigured && !context) {
    redirect("/login?next=/onboarding");
  }

  // 이미 조직에 소속된 계정은 이 화면에 머무를 이유가 없다.
  if (context?.organizationId) {
    redirect("/dashboard");
  }

  // 프로덕션에서는 개발 안내 박스를 아예 트리에서 제외한다(여백까지 제거).
  const isProduction = process.env.NODE_ENV === "production";
  const showDevPanel = !isProduction && isDevOrgBypassEnabled();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a" }}>판매자 정보 설정</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "6px", lineHeight: 1.7 }}>
          이 계정은 아직 소속된 공급사 조직이 없습니다. 조직을 만들면 상품·단가·발주 데이터가
          조직 단위로 분리되어 관리되고, 직원을 초대할 수 있습니다.
          {context?.email && (
            <>
              <br />
              <span style={{ color: "#94a3b8" }}>로그인 계정: {context.email}</span>
            </>
          )}
        </p>
      </header>

      {!supabaseConfigured && (
        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
            lineHeight: 1.6,
          }}
        >
          ℹ️ Supabase 환경변수가 설정되지 않은 데모 모드입니다. 조직 생성은 동작하지 않으며,
          백오피스는 샘플 데이터로 열람할 수 있습니다.
        </div>
      )}

      {context?.isSuperAdmin && (
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

      {showDevPanel ? (
        <section style={{ ...cardStyle, borderColor: "#bfdbfe", backgroundColor: "#f8fbff" }}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#1e40af", marginBottom: "6px" }}>
            개발/테스트 모드
          </div>
          <p style={{ fontSize: "13px", color: "#475569", lineHeight: 1.6, marginBottom: "12px" }}>
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
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "14px" }}>
          새 조직 만들기
        </div>
        <OrganizationCreateForm />
      </section>
    </div>
  );
}
