"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ORDER_STATUS_BADGES,
  ACTIVE_STATUS_FILTERS,
  HISTORICAL_STATUS_FILTERS,
  formatOrderedAt,
  formatWon,
  resolveAlimtalkStatus,
} from "@/lib/orders/status";
import { ORDER_HISTORY_RANGE_OPTIONS } from "@/lib/orders/history-range";
import type { OrderRow } from "@/lib/orders/order-row";
import { SampleBadge } from "@/components/sample-badge";
import { getHistoricalOrdersAction, searchHistoricalOrdersAction } from "./actions";
import type { OrderStatus } from "@/types/database";

type OrderGroup = "active" | "historical";

export type { OrderRow } from "@/lib/orders/order-row";

/** 발주번호가 길어서 모바일에서 길게 눌러 선택하기 번거로우므로 한 번에 복사하는 버튼. */
function CopyOrderNumberButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드 API를 못 쓰는 환경(권한 거부 등) — 텍스트 길게 눌러 선택하는 방식은 여전히 가능하다.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="발주번호 복사"
      style={{
        border: "1px solid #e2e8f0",
        background: copied ? "#dcfce7" : "#ffffff",
        color: copied ? "#166534" : "#94a3b8",
        borderRadius: "4px",
        padding: "2px 6px",
        fontSize: "11px",
        fontWeight: 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {copied ? "복사됨" : "복사"}
    </button>
  );
}

interface OrderBoardProps {
  /** 접수대기~취소반려 — 기간 제한 없이 항상 전체를 받는다 */
  activeOrders: OrderRow[];
  /** 배송완료/취소 — 최초 로드는 기본 구간(DEFAULT_ORDER_HISTORY_DAYS) 첫 페이지만 받는다 */
  initialHistoricalOrders: OrderRow[];
  initialHistoryRangeDays: number;
  /** 배송완료/취소 전체 개수(지금 구간 기준) — "총 N건" 표시용 */
  initialHistoryTotalCount: number;
  initialHistoryHasMore: boolean;
  /** 이 공급사의 비즈뿌리오 연동 여부 (미연동 시 "미발송(연동 필요)"으로 표기) */
  isLiveChannel: boolean;
  /** 샘플(데모) 발주서 여부 — 각 행/카드에 "샘플" 배지를 붙인다. */
  isDemo?: boolean;
}

export function OrderBoard({
  activeOrders,
  initialHistoricalOrders,
  initialHistoryRangeDays,
  initialHistoryTotalCount,
  initialHistoryHasMore,
  isLiveChannel,
  isDemo = false,
}: OrderBoardProps) {
  // 진행중과 완료·취소는 데이터 로딩 방식 자체가 다르므로(진행중=항상 전체,
  // 완료·취소=기간 제한+페이지네이션) 하나의 목록으로 섞지 않고 탭으로 분리한다.
  const [group, setGroup] = useState<OrderGroup>("active");
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "all">("all");
  const [keyword, setKeyword] = useState("");
  const filterScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const [historicalOrders, setHistoricalOrders] = useState(initialHistoricalOrders);
  const [historyRangeDays, setHistoryRangeDays] = useState<number | null>(initialHistoryRangeDays);
  const [historyTotalCount, setHistoryTotalCount] = useState(initialHistoryTotalCount);
  const [historyHasMore, setHistoryHasMore] = useState(initialHistoryHasMore);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);

  // 완료·취소 탭 검색 — 조회 구간(30일/3개월)에 갇히면 예전 발주를 못 찾으므로
  // 전체 기간을 서버에서 재조회한다. null = 검색 중이 아님(구간 뷰 표시).
  const [historySearchResults, setHistorySearchResults] = useState<OrderRow[] | null>(null);
  const [historySearchLoading, setHistorySearchLoading] = useState(false);

  const normalizedKeyword = keyword.trim().toLowerCase();
  const isHistorySearch = group === "historical" && normalizedKeyword.length > 0 && !isDemo;

  const filters = group === "active" ? ACTIVE_STATUS_FILTERS : HISTORICAL_STATUS_FILTERS;

  const handleGroupChange = (nextGroup: OrderGroup) => {
    if (nextGroup === group) return;
    setGroup(nextGroup);
    setStatusFilter("all");
    setKeyword("");
    setHistorySearchResults(null);
  };

  // 데모는 실제 DB가 없어 서버 검색을 탈 수 없으므로, 완료·취소 탭도 클라이언트에서
  // 필터링한다(데이터 양이 적어 성능 문제 없음).
  useEffect(() => {
    if (group !== "historical" || isDemo) return;

    const trimmed = keyword.trim();

    if (!trimmed) {
      setHistorySearchResults(null);
      setHistorySearchLoading(false);
      return;
    }

    setHistorySearchLoading(true);

    const timer = setTimeout(() => {
      void searchHistoricalOrdersAction(trimmed).then((result) => {
        setHistorySearchResults(result.success ? result.data?.entries ?? [] : []);
        setHistorySearchLoading(false);
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [group, keyword, isDemo]);

  const baseOrders =
    group === "active"
      ? activeOrders
      : isHistorySearch
        ? (historySearchResults ?? [])
        : historicalOrders;

  const orders = useMemo(() => baseOrders, [baseOrders]);

  const updateFilterScrollFade = () => {
    const el = filterScrollRef.current;
    if (!el) return;
    setCanScrollRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  };

  useEffect(() => {
    updateFilterScrollFade();
    window.addEventListener("resize", updateFilterScrollFade);
    return () => window.removeEventListener("resize", updateFilterScrollFade);
  }, [orders]);

  const handleRangeChange = (days: number | null) => {
    if (days === historyRangeDays) return;

    setHistoryLoading(true);

    void getHistoricalOrdersAction(days, 0).then((result) => {
      if (result.success) {
        setHistoricalOrders(result.data?.entries ?? []);
        setHistoryTotalCount(result.data?.totalCount ?? 0);
        setHistoryHasMore(result.data?.hasMore ?? false);
        setHistoryRangeDays(days);
      }

      setHistoryLoading(false);
    });
  };

  const handleLoadMoreHistory = () => {
    setHistoryLoadingMore(true);

    void getHistoricalOrdersAction(historyRangeDays, historicalOrders.length).then((result) => {
      if (result.success) {
        setHistoricalOrders((prev) => [...prev, ...(result.data?.entries ?? [])]);
        setHistoryTotalCount(result.data?.totalCount ?? historyTotalCount);
        setHistoryHasMore(result.data?.hasMore ?? false);
      }

      setHistoryLoadingMore(false);
    });
  };

  // isHistorySearch가 참이면 orders는 이미 서버에서 키워드로 걸러진 검색 결과라
  // 다시 텍스트로 거를 필요 없다. 진행중 탭과 데모의 완료·취소 탭만 클라이언트에서 거른다.
  const keywordFilteredOrders =
    !isHistorySearch && normalizedKeyword
      ? orders.filter(
          (order) =>
            order.orderNumber.toLowerCase().includes(normalizedKeyword) ||
            order.retailerName.toLowerCase().includes(normalizedKeyword)
        )
      : orders;

  const visibleOrders = keywordFilteredOrders.filter((order) =>
    statusFilter === "all" ? true : order.status === statusFilter
  );

  const countFor = (filter: OrderStatus | "all") =>
    filter === "all"
      ? keywordFilteredOrders.length
      : keywordFilteredOrders.filter((order) => order.status === filter).length;

  return (
    <section
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        overflow: "hidden",
      }}
    >
      {/* 그룹 탭 — 진행중(항상 전체 로드)과 완료·취소(기간 제한 로드)는 데이터 성격이
          달라서 하나로 섞지 않고 분리한다. */}
      <div style={{ display: "flex", borderBottom: "1px solid #e2e8f0" }}>
        {(
          [
            { key: "active" as const, label: "진행중", count: activeOrders.length },
            { key: "historical" as const, label: "완료·취소", count: historyTotalCount },
          ]
        ).map((tab) => {
          const isSelected = group === tab.key;

          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleGroupChange(tab.key)}
              style={{
                flex: 1,
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                gap: "6px",
                padding: "12px",
                fontSize: "14px",
                fontWeight: isSelected ? 800 : 600,
                color: isSelected ? "#0f172a" : "#94a3b8",
                backgroundColor: isSelected ? "#f8fafc" : "#ffffff",
                border: "none",
                borderBottom: isSelected ? "2px solid #0f172a" : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              {tab.label}
              <span
                style={{
                  fontSize: "11px",
                  padding: "1px 6px",
                  borderRadius: "10px",
                  backgroundColor: isSelected ? "#e2e8f0" : "#f1f5f9",
                  color: "#64748b",
                }}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 상태 필터 탭 — 오른쪽에 더 있으면 흐릿한 그라데이션으로 가로 스크롤 가능함을 알려준다 */}
      <div style={{ position: "relative", borderBottom: "1px solid #e2e8f0" }}>
        <div
          ref={filterScrollRef}
          onScroll={updateFilterScrollFade}
          style={{
            display: "flex",
            gap: "6px",
            padding: "12px",
            overflowX: "auto",
          }}
        >
        {filters.map((filter) => {
          const isSelected = statusFilter === filter;
          const label = filter === "all" ? "전체" : ORDER_STATUS_BADGES[filter].label;

          return (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "7px 13px",
                borderRadius: "20px",
                fontSize: "13px",
                fontWeight: isSelected ? 700 : 500,
                border: isSelected ? "1px solid #0f172a" : "1px solid #e2e8f0",
                backgroundColor: isSelected ? "#0f172a" : "#ffffff",
                color: isSelected ? "#ffffff" : "#475569",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <span>{label}</span>
              <span
                style={{
                  fontSize: "11px",
                  padding: "1px 6px",
                  borderRadius: "10px",
                  backgroundColor: isSelected ? "#334155" : "#f1f5f9",
                  color: isSelected ? "#f8fafc" : "#64748b",
                }}
              >
                {countFor(filter)}
              </span>
            </button>
          );
        })}
        </div>

        {canScrollRight && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: 0,
              width: "36px",
              background: "linear-gradient(to right, rgba(255,255,255,0), #ffffff)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      <div style={{ padding: "12px", borderBottom: "1px solid #e2e8f0" }}>
        <div style={{ position: "relative" }}>
          {/* type="search"는 브라우저 기본 지우기(×) 아이콘을 넣어주는데, 일부 인앱
              브라우저(카카오 등)에서 그 아이콘이 깨진 이미지(엑박)로 뜨는 문제가 있어서
              type="text"로 바꾸고 직접 만든 취소 버튼을 쓴다. */}
          <input
            type="text"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={
              group === "historical"
                ? "발주번호 또는 발주처(소매) 상호 검색 (전체 기간 대상)"
                : "발주번호 또는 발주처(소매) 상호 검색"
            }
            style={{
              width: "100%",
              padding: keyword ? "8px 60px 8px 10px" : "8px 10px",
              fontSize: "13px",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
            }}
          />
          {keyword && (
            <button
              type="button"
              onClick={() => setKeyword("")}
              style={{
                position: "absolute",
                right: "6px",
                top: "50%",
                transform: "translateY(-50%)",
                fontSize: "12px",
                fontWeight: 600,
                padding: "4px 9px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                backgroundColor: "#ffffff",
                color: "#334155",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              취소
            </button>
          )}
        </div>
      </div>

      {/* 완료·취소 탭에서 검색 중일 땐 조회구간/페이지네이션이 의미가 없어서
          검색 결과 건수만 보여주고, 검색 중이 아닐 때만 구간 선택 UI를 보여준다. */}
      {group === "historical" && isHistorySearch && (
        <div
          style={{
            padding: "10px 12px",
            borderBottom: "1px solid #e2e8f0",
            backgroundColor: "#f8fafc",
            fontSize: "12px",
            color: "#64748b",
          }}
        >
          {historySearchLoading
            ? "검색 중..."
            : `검색결과 ${visibleOrders.length}건 (전체 기간 중 최대 50건까지 표시)`}
        </div>
      )}

      {group === "historical" && !isHistorySearch && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "10px 12px",
            borderBottom: "1px solid #e2e8f0",
            backgroundColor: "#f8fafc",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: "12px", color: "#64748b" }}>배송완료·취소 조회 구간</span>
          {ORDER_HISTORY_RANGE_OPTIONS.map((option) => {
            const isSelected = historyRangeDays === option.days;

            return (
              <button
                key={option.label}
                type="button"
                onClick={() => handleRangeChange(option.days)}
                disabled={isDemo || (historyLoading && !isSelected)}
                style={{
                  fontSize: "12px",
                  fontWeight: isSelected ? 700 : 500,
                  padding: "5px 10px",
                  borderRadius: "999px",
                  border: isSelected ? "1px solid #0f172a" : "1px solid #cbd5e1",
                  backgroundColor: isSelected ? "#0f172a" : "#ffffff",
                  color: isSelected ? "#ffffff" : "#475569",
                  cursor: isDemo ? "not-allowed" : "pointer",
                }}
              >
                {option.label}
              </button>
            );
          })}
          {historyLoading && (
            <span style={{ fontSize: "12px", color: "#94a3b8" }}>불러오는 중...</span>
          )}

          <span style={{ fontSize: "12px", color: "#94a3b8", marginLeft: "auto" }}>
            배송완료·취소 총 {historyTotalCount}건 · {historicalOrders.length} /{" "}
            {historyTotalCount}건 조회됨
          </span>

          {historyHasMore && (
            <button
              type="button"
              onClick={handleLoadMoreHistory}
              disabled={historyLoadingMore}
              style={{
                fontSize: "12px",
                fontWeight: 700,
                padding: "5px 10px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                backgroundColor: "#ffffff",
                color: "#334155",
                cursor: historyLoadingMore ? "not-allowed" : "pointer",
              }}
            >
              {historyLoadingMore ? "불러오는 중..." : "다음"}
            </button>
          )}
        </div>
      )}

      {visibleOrders.length === 0 ? (
        <p style={{ padding: "40px 16px", textAlign: "center", fontSize: "13px", color: "#94a3b8" }}>
          조건에 맞는 발주서가 없습니다.
        </p>
      ) : (
        <>
        <div className="dash-table-wrap dash-desktop-only">
          <table className="dash-table">
            <thead>
              <tr>
                <th>발주번호 / 접수일시</th>
                <th>발주처(소매)</th>
                <th>발주 품목</th>
                <th>총 금액</th>
                <th>발주 상태</th>
                <th>알림톡 발송</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => {
                const badge = ORDER_STATUS_BADGES[order.status];
                const alimtalk = resolveAlimtalkStatus(order.status);

                return (
                  <tr key={order.id} style={{ opacity: order.status === "cancelled" ? 0.6 : 1 }}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <div style={{ fontWeight: 700 }}>{order.orderNumber}</div>
                        <CopyOrderNumberButton value={order.orderNumber} />
                        {isDemo && <SampleBadge />}
                      </div>
                      <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                        {formatOrderedAt(order.orderedAt)}
                      </div>
                    </td>

                    <td>
                      <div style={{ fontWeight: 600 }}>{order.retailerName}</div>
                      <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                        {order.deliveryAddress}
                      </div>
                    </td>

                    <td style={{ fontSize: "12px", color: "#334155" }}>
                      {order.itemSummary}
                      <span style={{ color: "#94a3b8" }}> ({order.itemCount}개 품목)</span>
                    </td>

                    <td style={{ whiteSpace: "nowrap", fontWeight: 700 }}>
                      {formatWon(order.totalAmount)}
                    </td>

                    <td>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          backgroundColor: badge.bg,
                          color: badge.color,
                          borderRadius: "4px",
                          padding: "4px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {badge.label}
                      </span>
                    </td>

                    <td>
                      <span
                        style={{
                          display: "inline-block",
                          fontSize: "11px",
                          fontWeight: 700,
                          backgroundColor: alimtalk.bg,
                          color: alimtalk.color,
                          borderRadius: "4px",
                          padding: "4px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        💬 {alimtalk.label}
                      </span>
                      <div style={{ fontSize: "10px", color: "#94a3b8", marginTop: "3px" }}>
                        {alimtalk.target} · {isLiveChannel ? "실발송" : "미발송(연동 필요)"}
                      </div>
                    </td>

                    <td>
                      <Link
                        href={`/dashboard/orders/${order.id}`}
                        style={{
                          display: "inline-block",
                          fontSize: "12px",
                          fontWeight: 600,
                          padding: "5px 9px",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          color: "#334155",
                          whiteSpace: "nowrap",
                        }}
                      >
                        상세 보기
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="dash-mobile-only" style={{ flexDirection: "column", gap: "10px", padding: "12px" }}>
          {visibleOrders.map((order) => {
            const badge = ORDER_STATUS_BADGES[order.status];
            const alimtalk = resolveAlimtalkStatus(order.status);

            return (
              <div
                key={order.id}
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "12px",
                  opacity: order.status === "cancelled" ? 0.6 : 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "#64748b",
                        backgroundColor: "#f1f5f9",
                        borderRadius: "4px",
                        padding: "3px 7px",
                      }}
                    >
                      {order.orderNumber}
                    </span>
                    <CopyOrderNumberButton value={order.orderNumber} />
                    {isDemo && <SampleBadge />}
                  </div>
                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                    {formatOrderedAt(order.orderedAt)}
                  </span>
                </div>

                <div>
                  <div style={{ fontWeight: 700, fontSize: "15px", color: "#0f172a" }}>
                    {order.retailerName}
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                    {order.deliveryAddress}
                  </div>
                </div>

                <div style={{ fontSize: "13px", color: "#334155" }}>
                  {order.itemSummary}
                  <span style={{ color: "#94a3b8" }}> ({order.itemCount}개 품목)</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                    {formatWon(order.totalAmount)}
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      backgroundColor: badge.bg,
                      color: badge.color,
                      borderRadius: "4px",
                      padding: "4px 8px",
                    }}
                  >
                    {badge.label}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    borderTop: "1px solid #f1f5f9",
                    paddingTop: "8px",
                  }}
                >
                  <div>
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: "11px",
                        fontWeight: 700,
                        backgroundColor: alimtalk.bg,
                        color: alimtalk.color,
                        borderRadius: "4px",
                        padding: "4px 8px",
                      }}
                    >
                      💬 {alimtalk.label}
                    </span>
                    <div style={{ fontSize: "10px", color: "#94a3b8", marginTop: "3px" }}>
                      {alimtalk.target} · {isLiveChannel ? "실발송" : "미발송(연동 필요)"}
                    </div>
                  </div>

                  <Link
                    href={`/dashboard/orders/${order.id}`}
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      padding: "6px 12px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      color: "#334155",
                    }}
                  >
                    상세 보기
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
    </section>
  );
}
