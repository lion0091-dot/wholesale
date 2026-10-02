"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { setWholesalerFeatureAction } from "./actions";

export interface FeatureRow {
  wholesalerId: string;
  businessName: string;
  featureKey: string;
  featureLabel: string;
  enabled: boolean;
  /** true면 운영자가 이 업체에 직접 정한 값, false면 기능 메뉴판의 기본값을 따르는 중 */
  isOverride: boolean;
}

const cardStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "10px 14px",
} as const;

export function FeatureManager({ rows }: { rows: FeatureRow[] }) {
  const [state, setState] = useState(rows);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();

  const shown = useMemo(
    () => state.filter((row) => !query.trim() || row.businessName.toLowerCase().includes(query.trim().toLowerCase())),
    [state, query]
  );

  const change = (row: FeatureRow, enabled: boolean) => {
    const key = `${row.wholesalerId}:${row.featureKey}`;

    setError(null);
    setBusyKey(key);

    startTransition(async () => {
      const result = await setWholesalerFeatureAction(row.wholesalerId, row.featureKey, enabled);

      if (!result.success) {
        setError(result.error ?? "저장하지 못했습니다.");
        setBusyKey(null);
        return;
      }

      setState((prev) =>
        prev.map((item) =>
          item.wholesalerId === row.wholesalerId && item.featureKey === row.featureKey
            ? { ...item, enabled, isOverride: true }
            : item
        )
      );
      setBusyKey(null);
    });
  };

  return (
    <>
      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="업체 이름으로 찾기"
        aria-label="업체 이름으로 찾기"
        style={{ fontSize: "13px", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: "8px", maxWidth: "320px" }}
      />

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: "12px", color: "#b91c1c" }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {shown.length === 0 && <p style={{ fontSize: "13px", color: "#64748b" }}>보여줄 업체가 없습니다.</p>}

        {shown.map((row) => {
          const key = `${row.wholesalerId}:${row.featureKey}`;
          const busy = busyKey === key && pending;

          return (
            <div
              key={key}
              style={{ ...cardStyle, display: "flex", gap: "12px", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", opacity: busy ? 0.6 : 1 }}
            >
              <div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>{row.businessName}</div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                  {row.featureLabel}
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <Link
                  href={`/admin/features/history?w=${row.wholesalerId}`}
                  style={{ fontSize: "12px", color: "#1d4ed8", fontWeight: 600 }}
                >
                  이력
                </Link>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => change(row, !row.enabled)}
                  aria-pressed={row.enabled}
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    padding: "6px 14px",
                    borderRadius: "999px",
                    border: `1px solid ${row.enabled ? "#16a34a" : "#cbd5e1"}`,
                    backgroundColor: row.enabled ? "#dcfce7" : "#f1f5f9",
                    color: row.enabled ? "#166534" : "#475569",
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  {row.enabled ? "켜짐 (누르면 끔)" : "꺼짐 (누르면 켬)"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
