"use client";

import { useState, useTransition } from "react";
import { getRowAuditLogAction, type AuditLogTable, type RowAuditEntry } from "@/app/actions/audit-log";
import { AUDIT_LOG_PAGE_SIZE } from "@/lib/audit-log/pagination";

interface AuditLogPanelProps {
  tableName: AuditLogTable;
  rowId: string;
  /** 버튼 라벨 — 기본 "변경 이력". 시크릿딜/맞춤단가처럼 섹션이 나뉜 곳은 구분되게 지정한다. */
  label?: string;
  /** 좁은 칩/배지 안에 끼워 넣을 때(예: 시크릿딜 노출 대상 칩) — 버튼을 작게 줄인다. */
  compact?: boolean;
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
 * products/custom_prices/orders 공용 변경 이력. 표가 테이블 행/카드 안에 인라인으로
 * 펼쳐지면 좁은 공간에 눌려 보기 어려워서(특히 필드가 많은 등록 이력) 모달로 띄운다
 * — 다른 화면(customer-table.tsx)의 모달과 같은 스타일(고정 배경+중앙 카드)을 따른다.
 * 버튼 클릭 시 지연 로드하고, AUDIT_LOG_PAGE_SIZE(10)개씩 "더보기"로 이어서 불러온다.
 */
export function AuditLogPanel({ tableName, rowId, label = "변경 이력", compact = false }: AuditLogPanelProps) {
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

  const handleOpen = () => {
    setOpen(true);

    if (entries === null) {
      loadPage(0, false);
    }
  };

  const handleLoadMore = () => {
    loadPage(entries?.length ?? 0, true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        style={
          compact
            ? {
                fontSize: "11px",
                fontWeight: 700,
                color: "#166534",
                backgroundColor: "transparent",
                border: "none",
                textDecoration: "underline",
                cursor: "pointer",
                padding: "0 2px",
              }
            : {
                fontSize: "12px",
                fontWeight: 700,
                color: "#334155",
                backgroundColor: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                padding: "10px 14px",
                minHeight: "40px",
                cursor: "pointer",
              }
        }
      >
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            backgroundColor: "rgba(15, 23, 42, 0.82)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            style={{
              backgroundColor: "#ffffff",
              borderRadius: "14px",
              padding: "20px",
              width: "100%",
              maxWidth: "720px",
              maxHeight: "88vh",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
              <div style={{ flex: 1 }}>
                <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{label}</h2>
                {entries && entries.length > 0 && (
                  <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>총 {totalCount}건</p>
                )}
              </div>
              <button
                type="button"
                aria-label="닫기"
                onClick={() => setOpen(false)}
                style={{
                  border: "none",
                  background: "none",
                  fontSize: "20px",
                  lineHeight: 1,
                  color: "#94a3b8",
                  cursor: "pointer",
                  padding: "2px 4px",
                }}
              >
                ×
              </button>
            </div>

            {pending ? (
              <p style={{ fontSize: "12px", color: "#94a3b8" }}>불러오는 중...</p>
            ) : !entries || entries.length === 0 ? (
              <p style={{ fontSize: "12px", color: "#94a3b8" }}>변경 이력이 없습니다.</p>
            ) : (
              <>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #cbd5e1", color: "#64748b" }}>
                        <th style={{ textAlign: "left", padding: "6px 8px", whiteSpace: "nowrap" }}>시간</th>
                        <th style={{ textAlign: "left", padding: "6px 8px", whiteSpace: "nowrap" }}>처리자</th>
                        <th style={{ textAlign: "left", padding: "6px 8px", whiteSpace: "nowrap" }}>동작</th>
                        <th style={{ textAlign: "left", padding: "6px 8px" }}>필드</th>
                        <th style={{ textAlign: "left", padding: "6px 8px" }}>변경 전</th>
                        <th style={{ textAlign: "left", padding: "6px 8px" }}>변경 후</th>
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
                                  style={{ padding: "6px 8px", verticalAlign: "top", whiteSpace: "nowrap" }}
                                >
                                  {new Date(entry.createdAt).toLocaleString("ko-KR")}
                                </td>
                                <td rowSpan={rows.length} style={{ padding: "6px 8px", verticalAlign: "top" }}>
                                  {entry.changedByName}
                                </td>
                                <td rowSpan={rows.length} style={{ padding: "6px 8px", verticalAlign: "top" }}>
                                  {ACTION_LABELS[entry.action]}
                                </td>
                              </>
                            )}
                            {change ? (
                              <>
                                <td style={{ padding: "6px 8px" }}>{change.field}</td>
                                <td style={{ padding: "6px 8px", color: "#94a3b8" }}>
                                  {formatValue(change.before)}
                                </td>
                                <td style={{ padding: "6px 8px", fontWeight: 600 }}>
                                  {formatValue(change.after)}
                                </td>
                              </>
                            ) : (
                              <td colSpan={3} style={{ padding: "6px 8px", color: "#94a3b8" }}>
                                -
                              </td>
                            )}
                          </tr>
                        ));
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {hasMore && (
                    <button
                      type="button"
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      style={{
                        fontSize: "12px",
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
                  <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                    {entries.length} / {totalCount}건 조회됨
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
