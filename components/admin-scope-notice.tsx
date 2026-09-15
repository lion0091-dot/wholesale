import Link from "next/link";

/**
 * super_admin이 특정 업체(wholesaler)에 소속되지 않은 채 공급사 백오피스(/dashboard/*)에
 * 들어왔을 때 보여주는 안내. 데모 데이터를 "내 회사 데이터"처럼 보여주면 혼동되므로,
 * 대신 이 화면은 관리자 권한과 무관하다는 것과 실제 관리 콘솔 위치를 알려준다.
 */
export function AdminScopeNotice() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "40px 24px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "32px", marginBottom: "10px" }}>🛡️</div>
        <h1 style={{ fontSize: "17px", fontWeight: 800, color: "#0f172a" }}>
          이 화면은 공급사 전용입니다
        </h1>
        <p
          style={{
            fontSize: "13px",
            color: "#64748b",
            marginTop: "8px",
            lineHeight: 1.6,
            maxWidth: "480px",
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          관리자(슈퍼관리자) 계정은 특정 업체 데이터에 자동으로 연결되지 않습니다. 공급사
          입점 승인/관리는 관리자 콘솔에서 진행해주세요.
        </p>
        <Link
          href="/admin/suppliers"
          style={{
            display: "inline-block",
            marginTop: "18px",
            backgroundColor: "#0f172a",
            color: "#ffffff",
            fontSize: "13px",
            fontWeight: 700,
            padding: "10px 18px",
            borderRadius: "8px",
            textDecoration: "none",
          }}
        >
          관리자 콘솔로 이동 →
        </Link>
      </div>
    </div>
  );
}
