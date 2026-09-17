import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { getOrgStaffContext } from "@/lib/auth/rbac";
import { listOrganizationStaff, listStaffInvitesAction } from "@/app/actions/organization";
import { TeamManagementPanel } from "./team-management-panel";

export const metadata = {
  title: "팀원 관리 | 미트 파트너스",
};

const noticeStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px dashed #cbd5e1",
  borderRadius: "12px",
  padding: "40px 20px",
  textAlign: "center",
  color: "#64748b",
  fontSize: "13px",
  lineHeight: 1.7,
};

/**
 * 공급사 자체 직원 관리 화면.
 *
 * 카카오 OAuth 전용 초대 링크(/join-team/<token>)로 직원을 합류시키고, owner/manager가
 * 역할 변경·삭제·초대 링크 발급/회수를 수행한다. 이메일 기반 옛 inviteStaff()는 폐기했다
 * (app/actions/organization.ts 참고).
 */
export default async function TeamPage() {
  if (!isSupabaseConfigured()) {
    return (
      <main style={{ maxWidth: "720px", margin: "0 auto", padding: "24px 16px" }}>
        <div style={noticeStyle}>데모 모드에서는 팀원 관리를 사용할 수 없습니다.</div>
      </main>
    );
  }

  const context = await getOrgStaffContext();

  if (!context) {
    redirect("/login?next=/dashboard/team");
  }

  if (!context.organizationId && !context.isSuperAdmin) {
    return (
      <main style={{ maxWidth: "720px", margin: "0 auto", padding: "24px 16px" }}>
        <div style={noticeStyle}>
          소속된 공급사 조직이 없습니다. 온보딩을 먼저 완료해주세요.
        </div>
      </main>
    );
  }

  if (!context.organizationId && context.isSuperAdmin) {
    return (
      <main style={{ maxWidth: "720px", margin: "0 auto", padding: "24px 16px" }}>
        <div style={noticeStyle}>
          슈퍼관리자 계정은 소속 조직이 없어 이 화면에서 특정 업체의 팀을 관리할 수 없습니다.
        </div>
      </main>
    );
  }

  const [staffResult, inviteResult] = await Promise.all([
    listOrganizationStaff(),
    listStaffInvitesAction(),
  ]);

  const canManage = context.orgRole === "owner" || context.orgRole === "manager";

  return (
    <main style={{ maxWidth: "720px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "20px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>팀원 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "6px", lineHeight: 1.6 }}>
          카카오 로그인만으로 직원을 합류시킵니다. 초대 링크를 만들어 직원에게 전달하면,
          그 직원이 본인 카카오 계정으로 로그인하는 순간 자동으로 팀에 합류합니다.
        </p>
      </header>

      <TeamManagementPanel
        currentUserId={context.userId}
        orgRole={context.orgRole}
        canManage={canManage}
        initialStaff={staffResult.success ? staffResult.data ?? [] : []}
        initialInvites={inviteResult.success ? inviteResult.data ?? [] : []}
      />
    </main>
  );
}
