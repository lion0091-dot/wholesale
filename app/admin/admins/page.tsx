import Link from "next/link";
import { requireAdminGranter } from "@/lib/auth/admin-granter";
import { listAdminsAction } from "./actions";
import { AdminAdminsClient } from "./admin-admins-client";

export default async function AdminAdminsPage() {
  // 다른 관리자를 승격/강등할 수 있는 계정(can_grant=true super_admin)만 통과.
  // 통과하지 못하면 내부에서 redirect() 로 처리되므로 실패 케이스는 신경 쓰지 않는다.
  const userId = await requireAdminGranter();

  const result = await listAdminsAction();

  if (!result.success) {
    return (
      <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
        <div
          role="alert"
          style={{
            backgroundColor: "#fee2e2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
          }}
        >
          {result.error ?? "관리자 목록을 불러오지 못했습니다."}
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "12px", color: "#dc2626", fontWeight: 700 }}>플랫폼 슈퍼 관리자</span>
          <Link href="/" style={{ fontSize: "12px", color: "#64748b", textDecoration: "underline" }}>
            ← 메인 허브로 이동
          </Link>
        </div>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px", marginBottom: "8px" }}>
          관리자 후보 목록
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b" }}>
          기존 관리자를 관리하거나, 이미 로그인한 계정을 검색해 새 관리자로 승격할 수 있습니다.
        </p>
      </header>

      <AdminAdminsClient initialAdmins={result.data ?? []} currentUserId={userId} />
    </main>
  );
}
