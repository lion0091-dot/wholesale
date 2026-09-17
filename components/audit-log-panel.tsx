"use client";

import { useState, useTransition } from "react";
import { getRowAuditLogAction, type RowAuditEntry } from "@/app/actions/audit-log";

interface AuditLogPanelProps {
  tableName: "products" | "custom_prices" | "orders";
  rowId: string;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return value.toLocaleString("ko-KR");
  return String(value);
}

const ACTION_LABELS: Record<RowAuditEntry["action"], string> = {
  insert: "등록",
  update: "수정",
  delete: "삭제",
};

/** products/custom_prices/orders 공용 변경 이력 패널. 버튼 클릭 시 지연 로드한다. */
export function AuditLogPanel({ tableName, rowId }: AuditLogPanelProps) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RowAuditEntry[] | null>(null);
  const [pending, startTransition] = useTransition();

  const handleToggle = () => {
    const next = !open;
    setOpen(next);

    if (next && entries === null) {
      startTransition(async () => {
        const result = await getRowAuditLogAction(tableName, rowId);
        setEntries(result.success ? (result.data ?? []) : []);
      });
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        style={{
          fontSize: "11px",
          fontWeight: 700,
          color: "#334155",
          backgroundColor: "#ffffff",
          border: "1px solid #cbd5e1",
          borderRadius: "6px",
          padding: "4px 10px",
          cursor: "pointer",
        }}
      >
        {open ? "이력 닫기" : "변경 이력"}
      </button>

      {open && (
        <div style={{ marginTop: "8px", fontSize: "11px", color: "#475569", lineHeight: 1.6 }}>
          {pending ? (
            <p style={{ color: "#94a3b8" }}>불러오는 중...</p>
          ) : !entries || entries.length === 0 ? (
            <p style={{ color: "#94a3b8" }}>변경 이력이 없습니다.</p>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} style={{ marginBottom: "4px" }}>
                <strong>{new Date(entry.createdAt).toLocaleString("ko-KR")}</strong> ·{" "}
                {entry.changedByName} · {ACTION_LABELS[entry.action]}
                {entry.changes.length > 0 && (
                  <span>
                    {" — "}
                    {entry.changes
                      .map((c) => `${c.field}: ${formatValue(c.before)} → ${formatValue(c.after)}`)
                      .join(", ")}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
