"use client";

import { useState } from "react";
import { revokeAdminAction, type AdminListEntry } from "./actions";

interface ActiveAdminsListProps {
  admins: AdminListEntry[];
  /** 회수 버튼 자체를 못 누르게(자기 자신) — 서버도 다시 막지만 화면에서 먼저 숨긴다. */
  currentUserId: string;
  /** 회수 성공 시 부모(page.tsx의 클라이언트 래퍼)의 admins state를 갱신한다. */
  onRevoked: (userId: string) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  env_root: "환경변수 루트",
  admin_grant: "관리자 승격",
  migration_backfill: "마이그레이션 백필",
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * 현재 활성 관리자(platform_admin_allowlist) 목록 + 회수 버튼.
 *
 * 자기 자신과 마지막 can_grant 보유자 회수는 revoke_platform_admin RPC가
 * 최종적으로 막지만(actions.ts 참고), 화면에서도 자기 자신 행은 회수 버튼을
 * 아예 숨겨 헛수고를 줄인다.
 */
export function ActiveAdminsList({ admins, currentUserId, onRevoked }: ActiveAdminsListProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRevoke = async (admin: AdminListEntry) => {
    if (
      !confirm(
        `${admin.name} 계정의 관리자 권한을 회수할까요? 즉시 일반 계정으로 강등되며 되돌리려면 다시 승격해야 합니다.`
      )
    ) {
      return;
    }

    setBusyId(admin.id);
    setError(null);

    try {
      const result = await revokeAdminAction(admin.id);

      if (!result.success) {
        setError(result.error ?? "회수에 실패했습니다.");
        return;
      }

      onRevoked(admin.id);
    } catch {
      setError("오류가 발생했습니다.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <h2 style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a", marginBottom: "10px" }}>
        현재 관리자 ({admins.length}명)
      </h2>

      {error && (
        <div
          role="alert"
          style={{
            backgroundColor: "#fee2e2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: "13px",
            padding: "10px 12px",
            borderRadius: "8px",
            marginBottom: "12px",
          }}
        >
          {error}
        </div>
      )}

      {admins.length === 0 ? (
        <div
          style={{
            backgroundColor: "#ffffff",
            borderRadius: "12px",
            border: "1px dashed #cbd5e1",
            padding: "32px 16px",
            textAlign: "center",
            color: "#64748b",
            fontSize: "13px",
          }}
        >
          활성 관리자가 없습니다.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {admins.map((admin) => {
            const isSelf = admin.id === currentUserId;
            const isBusy = busyId === admin.id;

            return (
              <div
                key={admin.id}
                style={{
                  backgroundColor: "#ffffff",
                  borderRadius: "10px",
                  border: "1px solid #e2e8f0",
                  padding: "14px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "10px",
                  opacity: isBusy ? 0.6 : 1,
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                      {admin.name}
                    </span>
                    {isSelf && (
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: "6px",
                          backgroundColor: "#f1f5f9",
                          color: "#475569",
                        }}
                      >
                        나
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: "6px",
                        backgroundColor: admin.canGrant ? "#e0e7ff" : "#f1f5f9",
                        color: admin.canGrant ? "#3730a3" : "#64748b",
                      }}
                    >
                      {admin.canGrant ? "명단 편집 가능" : "일반 관리자"}
                    </span>
                  </div>
                  <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                    {admin.phone || "연락처 미등록"} · {SOURCE_LABELS[admin.source] ?? admin.source} ·{" "}
                    {formatDate(admin.createdAt)} 등재
                  </p>
                </div>

                {!isSelf && (
                  <button
                    disabled={isBusy}
                    onClick={() => handleRevoke(admin)}
                    style={{
                      backgroundColor: "#ffffff",
                      color: "#dc2626",
                      fontSize: "12px",
                      fontWeight: 600,
                      padding: "6px 14px",
                      borderRadius: "6px",
                      border: "1px solid #fca5a5",
                      cursor: isBusy ? "not-allowed" : "pointer",
                    }}
                  >
                    {isBusy ? "처리 중..." : "권한 회수"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
