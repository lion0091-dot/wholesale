"use client";

import { useMemo, useState } from "react";
import { AuditLogPanel } from "@/components/audit-log-panel";
import type { AuditLogTable } from "@/app/actions/audit-log";

export interface HistoryPickerItem {
  id: string;
  title: string;
  subtitle?: string;
}

interface HistoryPickerListProps {
  tableName: AuditLogTable;
  items: HistoryPickerItem[];
  searchPlaceholder: string;
  emptyMessage: string;
}

/**
 * 상품/맞춤단가/핫딜 이력 메뉴 공용 "대상 찾기" 목록.
 * 목록 자체는 이미 전량 로드돼 있어(카탈로그 규모가 작아 페이지네이션 불필요,
 * 발주처럼 무한정 쌓이지 않음) 검색은 클라이언트에서 이름/부제로 필터링만 한다.
 * 각 행의 "이력보기"는 기존 AuditLogPanel을 그대로 재사용한다.
 */
export function HistoryPickerList({
  tableName,
  items,
  searchPlaceholder,
  emptyMessage,
}: HistoryPickerListProps) {
  const [keyword, setKeyword] = useState("");

  const filtered = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();

    if (!normalized) return items;

    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(normalized) ||
        (item.subtitle?.toLowerCase().includes(normalized) ?? false)
    );
  }, [items, keyword]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <input
        type="text"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder={searchPlaceholder}
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: "14px",
          border: "1px solid #cbd5e1",
          borderRadius: "8px",
          backgroundColor: "#ffffff",
          color: "#0f172a",
        }}
      />

      {items.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#94a3b8", padding: "20px 0", textAlign: "center" }}>
          {emptyMessage}
        </p>
      ) : filtered.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#94a3b8", padding: "20px 0", textAlign: "center" }}>
          검색 결과가 없습니다.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {filtered.map((item) => (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "12px 14px",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>{item.title}</div>
                {item.subtitle && (
                  <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>{item.subtitle}</div>
                )}
              </div>
              <AuditLogPanel tableName={tableName} rowId={item.id} label="이력보기" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
