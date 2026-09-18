"use client";

import { useState } from "react";
import { updateRetailerMatchRequestAction } from "./actions";

export interface RetailerLeadRow {
  id: string;
  restaurant_name: string;
  contact_name: string;
  contact_phone: string;
  region: string | null;
  desired_category: string | null;
  monthly_volume_hint: string | null;
  memo: string | null;
  status: "pending" | "contacted" | "matched" | "closed";
  admin_note: string | null;
  created_at: string;
}

interface RetailerLeadListProps {
  initialLeads: RetailerLeadRow[];
}

const STATUS_OPTIONS: Array<{ value: RetailerLeadRow["status"]; label: string }> = [
  { value: "pending", label: "대기중" },
  { value: "contacted", label: "공급사 컨택중" },
  { value: "matched", label: "매칭 완료" },
  { value: "closed", label: "종료(보류)" },
];

const STATUS_BADGES: Record<RetailerLeadRow["status"], { bg: string; color: string }> = {
  pending: { bg: "#fef3c7", color: "#92400e" },
  contacted: { bg: "#e0e7ff", color: "#3730a3" },
  matched: { bg: "#dcfce7", color: "#166534" },
  closed: { bg: "#f1f5f9", color: "#64748b" },
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RetailerLeadList({ initialLeads }: RetailerLeadListProps) {
  const [leads, setLeads] = useState(initialLeads);
  const [drafts, setDrafts] = useState<Record<string, { status: string; adminNote: string }>>(
    Object.fromEntries(
      initialLeads.map((lead) => [lead.id, { status: lead.status, adminNote: lead.admin_note ?? "" }])
    )
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  const handleSave = async (leadId: string) => {
    const draft = drafts[leadId];
    if (!draft) return;

    setSavingId(leadId);
    setErrorById((prev) => ({ ...prev, [leadId]: "" }));

    const result = await updateRetailerMatchRequestAction(leadId, draft.status, draft.adminNote);

    setSavingId(null);

    if (!result.success) {
      setErrorById((prev) => ({ ...prev, [leadId]: result.error ?? "저장에 실패했습니다." }));
      return;
    }

    setLeads((prev) =>
      prev.map((lead) =>
        lead.id === leadId
          ? { ...lead, status: draft.status as RetailerLeadRow["status"], admin_note: draft.adminNote || null }
          : lead
      )
    );
  };

  if (leads.length === 0) {
    return (
      <p style={{ fontSize: "13px", color: "#64748b", textAlign: "center", padding: "40px 0" }}>
        아직 접수된 입점 희망 신청이 없습니다.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {leads.map((lead) => {
        const draft = drafts[lead.id] ?? { status: lead.status, adminNote: lead.admin_note ?? "" };
        const badge = STATUS_BADGES[lead.status];

        return (
          <div
            key={lead.id}
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "12px",
              padding: "16px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
              <div>
                <div style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>{lead.restaurant_name}</div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                  {lead.contact_name} · {lead.contact_phone}
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "3px 10px",
                  borderRadius: "999px",
                  backgroundColor: badge.bg,
                  color: badge.color,
                  whiteSpace: "nowrap",
                }}
              >
                {STATUS_OPTIONS.find((option) => option.value === lead.status)?.label}
              </span>
            </div>

            <div style={{ fontSize: "12px", color: "#334155", marginTop: "10px", lineHeight: 1.7 }}>
              {lead.region && <div>■ 지역: {lead.region}</div>}
              {lead.desired_category && <div>■ 희망 품목: {lead.desired_category}</div>}
              {lead.monthly_volume_hint && <div>■ 예상 물량: {lead.monthly_volume_hint}</div>}
              {lead.memo && <div>■ 메모: {lead.memo}</div>}
              <div style={{ color: "#94a3b8", marginTop: "4px" }}>접수: {formatDate(lead.created_at)}</div>
            </div>

            <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <select
                  value={draft.status}
                  onChange={(event) =>
                    setDrafts((prev) => ({ ...prev, [lead.id]: { ...draft, status: event.target.value } }))
                  }
                  style={{
                    padding: "6px 8px",
                    fontSize: "12px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                  }}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={savingId === lead.id}
                  onClick={() => void handleSave(lead.id)}
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "#ffffff",
                    backgroundColor: savingId === lead.id ? "#94a3b8" : "#0f172a",
                    border: "none",
                    borderRadius: "6px",
                    padding: "6px 12px",
                    cursor: savingId === lead.id ? "default" : "pointer",
                  }}
                >
                  {savingId === lead.id ? "저장 중…" : "저장"}
                </button>
              </div>

              <textarea
                value={draft.adminNote}
                onChange={(event) =>
                  setDrafts((prev) => ({ ...prev, [lead.id]: { ...draft, adminNote: event.target.value } }))
                }
                placeholder="예: 마장동 태양축산에 의뢰함 — 회신 대기"
                rows={2}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: "12px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  resize: "vertical",
                }}
              />

              {errorById[lead.id] && (
                <p style={{ fontSize: "11px", color: "#b91c1c" }}>{errorById[lead.id]}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
