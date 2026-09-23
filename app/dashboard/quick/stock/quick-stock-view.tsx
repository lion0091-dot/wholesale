"use client";

import { useMemo, useState } from "react";
import { composeProductDisplayName } from "@/lib/products/display-name";

export interface QuickStockRow {
  id: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  grade: string | null;
  unit: string;
  stockQuantity: number;
}

const cardStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  backgroundColor: "#fff",
  padding: "12px 14px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "10px",
};

export function QuickStockView({ rows }: { rows: QuickStockRow[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) return rows;

    return rows.filter((row) =>
      composeProductDisplayName(row.category, row.name).toLowerCase().includes(query)
    );
  }, [rows, search]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <input
        type="text"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="상품명 검색"
        aria-label="상품명 검색"
        style={{
          padding: "10px 12px",
          borderRadius: "8px",
          border: "1px solid #cbd5e1",
          fontSize: "14px",
        }}
      />

      {filtered.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>
          {rows.length === 0 ? "등록된 상품이 없습니다." : "검색 결과가 없습니다."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {filtered.map((row) => {
            const empty = row.stockQuantity <= 0;

            return (
              <div key={row.id} style={cardStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                    {composeProductDisplayName(row.category, row.name)}
                    {row.subcategory ? ` · ${row.subcategory}` : ""}
                  </div>
                  {row.grade && (
                    <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>{row.grade}</div>
                  )}
                </div>

                <div
                  style={{
                    fontSize: "18px",
                    fontWeight: 800,
                    color: empty ? "#b91c1c" : "#0f172a",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.stockQuantity}
                  {row.unit}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
