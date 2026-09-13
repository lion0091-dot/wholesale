import Link from "next/link";
import { requireAdminGranter } from "@/lib/auth/admin-granter";

export default async function AdminAdminsPage() {
  // 다른 관리자를 승격/강등할 수 있는 계정(can_grant=true super_admin)만 통과.
  // 통과하지 못하면 내부에서 redirect() 로 처리되므로 반환값은 보지 않는다.
  await requireAdminGranter();

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
      </header>
    </main>
  );
}
