"use client";

import { ORDER_STATUS_BADGES, formatOrderedAt, formatWon } from "@/lib/orders/status";
import { ORDER_HISTORY_RANGE_OPTIONS } from "@/lib/orders/history-range";
import type { OrderRow } from "@/lib/orders/order-row";
import { useOrderHistoryPagination } from "@/lib/orders/use-order-history-pagination";
import { useDebouncedSearch } from "@/lib/orders/use-debounced-search";
import { AuditLogPanel } from "@/components/audit-log-panel";
import { listOrdersForHistoryAction, searchOrdersForHistoryAction } from "./actions";

interface OrderHistoryPickerProps {
  initialEntries: OrderRow[];
  initialTotalCount: number;
  initialHasMore: boolean;
  initialRangeDays: number;
  /** 소속 도매업체 정보가 없으면(데모/미인증) 조회 자체를 시도하지 않는다. */
  hasWholesaler: boolean;
}

/**
 * 발주이력 "대상 찾기" — 상태 무관 전체 발주를 대상으로 조회 구간(30일/3개월/전체)
 * + 더보기(useOrderHistoryPagination 공용 로직), 그리고 발주번호/거래처명 검색
 * (구간과 무관하게 전체 기간에서 찾음)을 제공한다.
 */
export function OrderHistoryPicker({
  initialEntries,
  initialTotalCount,
  initialHasMore,
  initialRangeDays,
  hasWholesaler,
}: OrderHistoryPickerProps) {
  const {
    entries,
    rangeDays,
    totalCount,
    hasMore,
    rangeLoading,
    moreLoading,
    isBusy,
    errorMessage,
    changeRange,
    loadMore,
  } = useOrderHistoryPagination(
    { entries: initialEntries, totalCount: initialTotalCount, hasMore: initialHasMore },
    initialRangeDays,
    listOrdersForHistoryAction
  );

  const {
    keyword,
    setKeyword,
    results: searchResults,
    loading: searchLoading,
    error: searchError,
    isSearching,
  } = useDebouncedSearch<OrderRow>(searchOrdersForHistoryAction);

  const rows = isSearching ? searchResults ?? [] : entries;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <input
        type="text"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder="발주번호 또는 거래처명으로 검색 (전체 기간)"
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

      {!isSearching && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {ORDER_HISTORY_RANGE_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                disabled={isBusy}
                onClick={() => void changeRange(option.days)}
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  padding: "6px 10px",
                  borderRadius: "999px",
                  border: rangeDays === option.days ? "1px solid #0f172a" : "1px solid #cbd5e1",
                  backgroundColor: rangeDays === option.days ? "#0f172a" : "#ffffff",
                  color: rangeDays === option.days ? "#ffffff" : "#334155",
                  cursor: isBusy ? "not-allowed" : "pointer",
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span style={{ fontSize: "12px", color: "#64748b" }}>총 {totalCount}건</span>
        </div>
      )}

      {(isSearching ? searchError : errorMessage) && (
        <p style={{ fontSize: "12px", color: "#b91c1c" }}>{isSearching ? searchError : errorMessage}</p>
      )}

      {!hasWholesaler ? (
        <p style={{ fontSize: "13px", color: "#94a3b8", padding: "20px 0", textAlign: "center" }}>
          공급사 업체 정보가 없어 조회할 수 없습니다.
        </p>
      ) : isSearching ? (
        searchLoading ? (
          <p style={{ fontSize: "13px", color: "#94a3b8", padding: "20px 0", textAlign: "center" }}>
            검색 중...
          </p>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8", padding: "20px 0", textAlign: "center" }}>
            검색 결과가 없습니다.
          </p>
        ) : (
          <OrderHistoryRows rows={rows} />
        )
      ) : rangeLoading ? (
        <p style={{ fontSize: "13px", color: "#94a3b8", padding: "20px 0", textAlign: "center" }}>
          불러오는 중...
        </p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#94a3b8", padding: "20px 0", textAlign: "center" }}>
          해당 조건의 발주가 없습니다.
        </p>
      ) : (
        <OrderHistoryRows rows={rows} />
      )}

      {!isSearching && hasMore && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={isBusy}
          style={{
            alignSelf: "center",
            fontSize: "13px",
            fontWeight: 700,
            color: "#334155",
            backgroundColor: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "10px 20px",
            cursor: isBusy ? "not-allowed" : "pointer",
          }}
        >
          {moreLoading ? "불러오는 중..." : "더보기"}
        </button>
      )}
    </div>
  );
}

function OrderHistoryRows({ rows }: { rows: OrderRow[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {rows.map((order) => {
        const badge = ORDER_STATUS_BADGES[order.status];

        return (
          <div
            key={order.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
              flexWrap: "wrap",
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              padding: "12px 14px",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                  {order.orderNumber}
                </span>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    backgroundColor: badge.bg,
                    color: badge.color,
                    padding: "2px 7px",
                    borderRadius: "10px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {badge.label}
                </span>
              </div>
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
                {order.retailerName} · {order.itemSummary} · {formatWon(order.totalAmount)}
              </div>
              <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                {formatOrderedAt(order.orderedAt)} 접수
              </div>
            </div>
            <AuditLogPanel tableName="orders" rowId={order.id} label="이력보기" />
          </div>
        );
      })}
    </div>
  );
}
