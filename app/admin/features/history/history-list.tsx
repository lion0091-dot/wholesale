"use client";

import { useMemo, useState } from "react";

export interface PeriodRow {
  id: string;
  businessName: string;
  featureLabel: string;
  startedAt: string;
  endedAt: string | null;
  startedByName: string;
  endedByName: string | null;
}

function formatAt(value: string): string {
  const date = new Date(value);

  return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}. ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 사용한 날수 — 켠 날부터 끈 날(진행 중이면 오늘)까지. 같은 날 켰다 껐으면 0일이다. */
function usedDays(row: PeriodRow): number {
  const end = row.endedAt ? new Date(row.endedAt).getTime() : Date.now();

  return Math.max(0, Math.floor((end - new Date(row.startedAt).getTime()) / 86_400_000));
}

export function HistoryList({ rows }: { rows: PeriodRow[] }) {
  const [query, setQuery] = useState("");

  const shown = useMemo(
    () => rows.filter((row) => !query.trim() || row.businessName.toLowerCase().includes(query.trim().toLowerCase())),
    [rows, query]
  );

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

      <section style={{ backgroundColor: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "8px 4px" }}>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>업체</th>
                <th>기능</th>
                <th>켠 시각</th>
                <th>끈 시각</th>
                <th>켠 사람</th>
                <th>끈 사람</th>
                <th>사용 기간</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ color: "#64748b" }}>
                    보여줄 이력이 없습니다.
                  </td>
                </tr>
              )}
              {shown.map((row) => (
                <tr key={row.id}>
                  <td style={{ fontWeight: 700 }}>{row.businessName}</td>
                  <td>{row.featureLabel}</td>
                  <td>{formatAt(row.startedAt)}</td>
                  <td>
                    {row.endedAt ? formatAt(row.endedAt) : <span style={{ color: "#166534", fontWeight: 700 }}>켜져 있음</span>}
                  </td>
                  <td>{row.startedByName}</td>
                  <td>{row.endedByName ?? "-"}</td>
                  <td>
                    {usedDays(row)}일{row.endedAt ? "" : " (진행 중)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
