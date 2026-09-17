"use client";

import { useMemo, useState, useTransition } from "react";
import {
  createStaffInviteAction,
  removeStaff,
  revokeStaffInviteAction,
  updateStaffRole,
  type OrganizationStaffMember,
  type StaffInvite,
} from "@/app/actions/organization";
import type { OrgRole } from "@/lib/auth/rbac";

interface TeamManagementPanelProps {
  currentUserId: string;
  orgRole: OrgRole | null;
  /** owner 또는 manager — 초대 링크 발급/취소, 역할 변경, 직원 삭제 가능 */
  canManage: boolean;
  initialStaff: OrganizationStaffMember[];
  initialInvites: StaffInvite[];
}

const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "대표",
  manager: "관리자",
  staff: "직원",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "20px",
  marginBottom: "16px",
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function inviteStatus(invite: StaffInvite): { label: string; color: string } {
  if (invite.revokedAt) {
    return { label: "취소됨", color: "#64748b" };
  }

  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    return { label: "만료됨", color: "#b91c1c" };
  }

  return { label: "사용 가능", color: "#166534" };
}

export function TeamManagementPanel({
  currentUserId,
  orgRole,
  canManage,
  initialStaff,
  initialInvites,
}: TeamManagementPanelProps) {
  const [staff, setStaff] = useState(initialStaff);
  const [invites, setInvites] = useState(initialInvites);
  const [newInviteRole, setNewInviteRole] = useState<OrgRole>("staff");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const assignableRoles = useMemo<OrgRole[]>(
    () => (orgRole === "owner" ? ["owner", "manager", "staff"] : ["staff"]),
    [orgRole]
  );

  const handleCreateInvite = () => {
    setError(null);

    startTransition(async () => {
      const result = await createStaffInviteAction(newInviteRole);

      if (!result.success || !result.data) {
        setError(result.error ?? "초대 링크 생성에 실패했습니다.");
        return;
      }

      setInvites((prev) => [result.data as StaffInvite, ...prev]);
    });
  };

  const handleRevokeInvite = (inviteId: string) => {
    setError(null);
    setBusyId(inviteId);

    startTransition(async () => {
      const result = await revokeStaffInviteAction(inviteId);

      if (!result.success) {
        setError(result.error ?? "초대 링크 취소에 실패했습니다.");
        setBusyId(null);
        return;
      }

      setInvites((prev) =>
        prev.map((invite) =>
          invite.id === inviteId ? { ...invite, revokedAt: new Date().toISOString() } : invite
        )
      );
      setBusyId(null);
    });
  };

  const handleRoleChange = (staffId: string, nextRole: OrgRole) => {
    setError(null);
    setBusyId(staffId);

    startTransition(async () => {
      const result = await updateStaffRole(staffId, nextRole);

      if (!result.success) {
        setError(result.error ?? "역할 변경에 실패했습니다.");
        setBusyId(null);
        return;
      }

      setStaff((prev) =>
        prev.map((member) => (member.id === staffId ? { ...member, role: nextRole } : member))
      );
      setBusyId(null);
    });
  };

  const handleRemoveStaff = (staffId: string, isSelf: boolean) => {
    if (
      !confirm(
        isSelf
          ? "정말 이 조직에서 탈퇴하시겠습니까?"
          : "정말 이 직원을 삭제하시겠습니까? 다시 합류하려면 새 초대 링크가 필요합니다."
      )
    ) {
      return;
    }

    setError(null);
    setBusyId(staffId);

    startTransition(async () => {
      const result = await removeStaff(staffId);

      if (!result.success) {
        setError(result.error ?? "삭제에 실패했습니다.");
        setBusyId(null);
        return;
      }

      setStaff((prev) => prev.filter((member) => member.id !== staffId));
      setBusyId(null);
    });
  };

  const copyInviteLink = async (token: string) => {
    const url = `${window.location.origin}/join-team/${token}`;

    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken((current) => (current === token ? null : current)), 2000);
    } catch {
      prompt("아래 링크를 복사해주세요", url);
    }
  };

  return (
    <div>
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
            marginBottom: "16px",
          }}
        >
          {error}
        </div>
      )}

      <section style={cardStyle}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "12px" }}>
          현재 팀원 ({staff.length}명)
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {staff.map((member) => {
            const isSelf = member.userId === currentUserId;
            const isBusy = busyId === member.id && pending;

            return (
              <div
                key={member.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "8px",
                  padding: "10px 12px",
                  border: "1px solid #f1f5f9",
                  borderRadius: "8px",
                  opacity: isBusy ? 0.6 : 1,
                }}
              >
                <div>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
                    {member.name || "이름 미등록"} {isSelf && "(나)"}
                  </div>
                  <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                    {member.phone || "연락처 미등록"} · 합류일 {formatDateTime(member.createdAt)}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {orgRole === "owner" && !isSelf ? (
                    <select
                      value={member.role}
                      disabled={isBusy}
                      onChange={(e) => handleRoleChange(member.id, e.target.value as OrgRole)}
                      style={{
                        fontSize: "12px",
                        padding: "5px 8px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                      }}
                    >
                      {(["owner", "manager", "staff"] as OrgRole[]).map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "#475569",
                        backgroundColor: "#f1f5f9",
                        borderRadius: "999px",
                        padding: "3px 10px",
                      }}
                    >
                      {ROLE_LABELS[member.role]}
                    </span>
                  )}

                  {(orgRole === "owner" || isSelf) && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleRemoveStaff(member.id, isSelf)}
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "#b91c1c",
                        backgroundColor: "#ffffff",
                        border: "1px solid #fca5a5",
                        borderRadius: "6px",
                        padding: "5px 10px",
                        cursor: isBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSelf ? "탈퇴" : "삭제"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {canManage && (
        <section style={cardStyle}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "4px" }}>
            새 초대 링크 만들기
          </div>
          <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.6, marginBottom: "12px" }}>
            역할을 정하고 링크를 만들면, 링크를 받은 사람이 본인 카카오 계정으로 로그인하는
            순간 자동으로 이 역할의 팀원이 됩니다. 7일간 유효하며 여러 명이 같은 링크로
            합류할 수 있습니다.
          </p>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <select
              value={newInviteRole}
              onChange={(e) => setNewInviteRole(e.target.value as OrgRole)}
              style={{
                fontSize: "13px",
                padding: "8px 10px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
              }}
            >
              {assignableRoles.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending}
              onClick={handleCreateInvite}
              style={{
                fontSize: "13px",
                fontWeight: 700,
                color: "#ffffff",
                backgroundColor: pending ? "#94a3b8" : "#0f172a",
                border: "none",
                borderRadius: "8px",
                padding: "8px 16px",
                cursor: pending ? "wait" : "pointer",
              }}
            >
              초대 링크 생성
            </button>
          </div>
        </section>
      )}

      {canManage && (
        <section style={cardStyle}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "12px" }}>
            발급된 초대 링크
          </div>

          {invites.length === 0 ? (
            <p style={{ fontSize: "13px", color: "#94a3b8" }}>아직 발급된 초대 링크가 없습니다.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {invites.map((invite) => {
                const status = inviteStatus(invite);
                const isActive = status.label === "사용 가능";
                const isBusy = busyId === invite.id && pending;

                return (
                  <div
                    key={invite.id}
                    style={{
                      padding: "10px 12px",
                      border: "1px solid #f1f5f9",
                      borderRadius: "8px",
                      opacity: isBusy ? 0.6 : 1,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: "8px",
                      }}
                    >
                      <div style={{ fontSize: "12px", color: "#334155" }}>
                        <strong>{ROLE_LABELS[invite.role]}</strong> · 사용 {invite.usedCount}회 ·
                        만료 {formatDateTime(invite.expiresAt)}
                        <span style={{ color: status.color, fontWeight: 700, marginLeft: "6px" }}>
                          {status.label}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          disabled={!isActive}
                          onClick={() => copyInviteLink(invite.token)}
                          style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            color: isActive ? "#0f172a" : "#cbd5e1",
                            backgroundColor: "#ffffff",
                            border: "1px solid #cbd5e1",
                            borderRadius: "6px",
                            padding: "5px 10px",
                            cursor: isActive ? "pointer" : "not-allowed",
                          }}
                        >
                          {copiedToken === invite.token ? "복사됨 ✓" : "링크 복사"}
                        </button>
                        {isActive && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleRevokeInvite(invite.id)}
                            style={{
                              fontSize: "11px",
                              fontWeight: 600,
                              color: "#b91c1c",
                              backgroundColor: "#ffffff",
                              border: "1px solid #fca5a5",
                              borderRadius: "6px",
                              padding: "5px 10px",
                              cursor: isBusy ? "not-allowed" : "pointer",
                            }}
                          >
                            취소
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
