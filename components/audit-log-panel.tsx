"use client";

import { useState, useTransition } from "react";
import { getRowAuditLogAction, type RowAuditEntry } from "@/app/actions/audit-log";
import { AUDIT_LOG_PAGE_SIZE } from "@/lib/audit-log/pagination";

interface AuditLogPanelProps {
  tableName: "products" | "custom_prices" | "orders";
  rowId: string;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "예" : "아니오";
  if (typeof value === "number") return value.toLocaleString("ko-KR");
  return String(value);
}

const ACTION_LABELS: Record<RowAuditEntry["action"], string> = {
  insert: "등록",
  update: "수정",
  delete: "삭제",
};

/**
 * products/custom_prices/orders 공용 변경 이력 패널. 버튼 클릭 시 지연 로드하고,
 * AUDIT_LOG_PAGE_SIZE(10)개씩 "더보기"로 이어서 불러온다 — 오래 쓴 행일수록
 * 이력이 무한정 쌓일 수 있어 전체를 한 번에 가져오지 않는다. 총 개수와
 * 지금까지 불러온 개수(누적)를 같이 보여준다.
 */
export function AuditLogPanel({ tableName, rowId }: AuditLogPanelProps) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RowAuditEntry[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pending, startTransition] = useTransition();
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = (offset: number, append: boolean) => {
    const finish = (result: Awaited<ReturnType<typeof getRowAuditLogAction>>) => {
      const page = result.success ? result.data : undefined;

      setEntries((prev) => (append ? [...(prev ?? []), ...(page?.entries ?? [])] : page?.entries ?? []));
      setTotalCount(page?.totalCount ?? 0);
      setHasMore(page?.hasMore ?? false);
      setLoadingMore(false);
    };

    if (append) {
      setLoadingMore(true);
      void getRowAuditLogAction(tableName, rowId, offset).then(finish);
    } else {
      startTransition(async () => {
        finish(await getRowAuditLogAction(tableName, rowId, offset));
      });
    }
  };

  const handleToggle = () => {
    const next = !open;
    setOpen(next);

    if (next && entries === null) {
      loadPage(0, false);
    }
  };

  const handleLoadMore = () => {
    loadPage(entries?.length ?? 0, true);
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        style={{
          fontSize: "12px",
          fontWeight: 700,
          color: "#334155",
          backgroundColor: "#ffffff",
          border: "1px solid #cbd5e1",
          borderRadius: "6px",
          padding: "10px 14px",
          minHeight: "40px",
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
            <>
              <p style={{ color: "#94a3b8", marginBottom: "4px" }}>총 {totalCount}건</p>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #cbd5e1", color: "#64748b" }}>
                      <th style={{ textAlign: "left", padding: "4px 6px", whiteSpace: "nowrap" }}>시간</th>
                      <th style={{ textAlign: "left", padding: "4px 6px", whiteSpace: "nowrap" }}>처리자</th>
                      <th style={{ textAlign: "left", padding: "4px 6px", whiteSpace: "nowrap" }}>동작</th>
                      <th style={{ textAlign: "left", padding: "4px 6px" }}>필드</th>
                      <th style={{ textAlign: "left", padding: "4px 6px" }}>변경 전</th>
                      <th style={{ textAlign: "left", padding: "4px 6px" }}>변경 후</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.flatMap((entry) => {
                      const rows = entry.changes.length > 0 ? entry.changes : [null];

                      return rows.map((change, index) => (
                        <tr key={`${entry.id}-${index}`} style={{ borderBottom: "1px solid #f1f5f9" }}>
                          {index === 0 && (
                            <>
                              <td
                                rowSpan={rows.length}
                                style={{ padding: "4px 6px", verticalAlign: "top", whiteSpace: "nowrap" }}
                              >
                                {new Date(entry.createdAt).toLocaleString("ko-KR")}
                              </td>
                              <td rowSpan={rows.length} style={{ padding: "4px 6px", verticalAlign: "top" }}>
                                {entry.changedByName}
                              </td>
                              <td rowSpan={rows.length} style={{ padding: "4px 6px", verticalAlign: "top" }}>
                                {ACTION_LABELS[entry.action]}
                              </td>
                            </>
                          )}
                          {change ? (
                            <>
                              <td style={{ padding: "4px 6px" }}>{change.field}</td>
                              <td style={{ padding: "4px 6px", color: "#94a3b8" }}>
                                {formatValue(change.before)}
                              </td>
                              <td style={{ padding: "4px 6px", fontWeight: 600 }}>
                                {formatValue(change.after)}
                              </td>
                            </>
                          ) : (
                            <td colSpan={3} style={{ padding: "4px 6px", color: "#94a3b8" }}>
                              -
                            </td>
                          )}
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px" }}>
                {hasMore && (
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      color: "#334155",
                      backgroundColor: "#ffffff",
                      border: "1px solid #cbd5e1",
                      borderRadius: "6px",
                      padding: "6px 10px",
                      cursor: loadingMore ? "not-allowed" : "pointer",
                    }}
                  >
                    {loadingMore ? "불러오는 중..." : "다음"}
                  </button>
                )}
                <span style={{ color: "#94a3b8" }}>
                  {entries.length} / {totalCount}건 조회됨
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
