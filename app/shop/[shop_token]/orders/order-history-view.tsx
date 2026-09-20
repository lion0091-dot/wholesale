"use client";

import { useState } from "react";
import Link from "next/link";
import { ORDER_STATUS_BADGES, canRequestCancel, formatOrderedAt } from "@/lib/orders/status";
import { ORDER_HISTORY_RANGE_OPTIONS } from "@/lib/orders/history-range";
import type { ShopCatalog } from "@/lib/shop/catalog-types";
import {
  CANCEL_REASON_MAX_LENGTH,
  describeCancelProgress,
  validateCancelReason,
  type ShopOrder,
  type ShopOrderHistory,
} from "@/lib/shop/order-history-types";
import {
  ShopFooter,
  ShopHeader,
  cardStyle,
  formatWon,
  inputStyle,
  labelStyle,
  shopPageStyle,
} from "../shop-chrome";
import {
  fetchBuyerTrackingStatusAction,
  loadShopOrderHistoryPageAction,
  requestOrderCancelAction,
} from "../actions";
import { StatementPreviewButton } from "@/components/statement-preview-button";
import { SampleBadge } from "@/components/sample-badge";
import { courierLabel, type TrackingResult } from "@/lib/verification/sweettracker";

interface OrderHistoryViewProps {
  catalog: ShopCatalog;
  history: ShopOrderHistory;
  /** 최초 로드 시 적용된 조회 구간(일) — 범위 선택 버튼의 초기 선택 상태 */
  initialRangeDays: number;
  /** 스위트트래커 API 키 미설정 시 배송 조회 버튼 자체를 숨긴다. */
  sweetTrackerConfigured: boolean;
  /** 주문 ID별 카카오 인앱 "외부에서 열기" 전용 토큰 경로(/doc/[token]). 없으면 기존 href로 폴백. */
  statementExternalOpenHrefByOrderId: Record<string, string>;
}

/** 자체 열림/조회 상태를 갖는 배송 조회 버튼 — StatementPreviewButton과 동일한 패턴. */
function TrackingLookupButton({ shopToken, order }: { shopToken: string; order: ShopOrder }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TrackingResult | null>(null);

  const handleToggle = async () => {
    const nextOpen = !open;
    setOpen(nextOpen);

    if (nextOpen && !result) {
      setPending(true);
      const response = await fetchBuyerTrackingStatusAction(shopToken, order.id);
      setPending(false);
      setResult(
        response.success && response.data
          ? response.data
          : { status: "error", message: response.error ?? "조회에 실패했습니다." }
      );
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => void handleToggle()}
        style={{
          fontSize: "13px",
          fontWeight: 700,
          color: "#2563eb",
          border: "1px solid #bfdbfe",
          backgroundColor: "#eff6ff",
          borderRadius: "6px",
          padding: "6px 10px",
          cursor: "pointer",
        }}
      >
        📦 {courierLabel(order.courierCode)} {order.trackingNumber} 배송 조회 {open ? "▲" : "▼"}
      </button>

      {open && (
        <div style={{ marginTop: "8px", fontSize: "13px" }}>
          {pending ? (
            <p style={{ color: "#334155" }}>조회 중...</p>
          ) : result ? (
            <p style={{ fontWeight: 700, color: result.status === "ok" ? "#166534" : "#b91c1c" }}>
              {result.message}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 취소 사유 예시 — 모바일에서 장문 입력이 번거로운 바이어를 위한 빠른 선택 */
const REASON_PRESETS = [
  "발주 수량을 잘못 입력했습니다.",
  "당일 예약 취소로 물량이 필요 없어졌습니다.",
  "다른 품목으로 재발주하겠습니다.",
  "납품 일정이 변경되었습니다.",
];

export function OrderHistoryView({
  catalog,
  history,
  initialRangeDays,
  sweetTrackerConfigured,
  statementExternalOpenHrefByOrderId,
}: OrderHistoryViewProps) {
  const { wholesaler, customer, shopToken } = catalog;

  /** 취소 사유 입력창이 열린 주문 ID */
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submittingOrderId, setSubmittingOrderId] = useState<string | null>(null);
  const [completedOrderId, setCompletedOrderId] = useState<string | null>(null);

  // 조회 구간(30일/3개월/전체) + 더보기 — 미인증/데모 상태(history.requiresLink,
  // catalog.isDemo)에서는 애초에 조회할 데이터가 없으므로 아래 상태는 그 경우엔 쓰이지 않는다.
  const canPaginate = !history.requiresLink && !catalog.isDemo;
  const [orders, setOrders] = useState<ShopOrder[]>(history.orders);
  const [rangeDays, setRangeDays] = useState<number | null>(initialRangeDays);
  const [totalCount, setTotalCount] = useState(history.totalCount);
  const [hasMore, setHasMore] = useState(history.hasMore);
  const [emptyNotice, setEmptyNotice] = useState<string | null>(
    orders.length === 0 ? history.notice : null
  );
  const [externalOpenHrefs, setExternalOpenHrefs] = useState(statementExternalOpenHrefByOrderId);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  // 구간 변경과 더보기가 동시에 나가면 먼저 온 응답이 나중 응답에 덮어써질 수 있어
  // (예: 더보기 중에 구간을 바꾸면 옛 구간의 더보기 결과가 새 구간 목록 뒤에 붙음)
  // 서로의 로딩 중에는 상대 조작을 막는다.
  const isBusy = rangeLoading || moreLoading;

  const handleRangeChange = async (nextRangeDays: number | null) => {
    if (nextRangeDays === rangeDays || isBusy) return;

    setRangeLoading(true);
    setRangeDays(nextRangeDays);

    const result = await loadShopOrderHistoryPageAction(shopToken, nextRangeDays, 0);
    setRangeLoading(false);

    if (!result.success || !result.data) {
      setOrders([]);
      setTotalCount(0);
      setHasMore(false);
      setEmptyNotice(result.error ?? "주문 내역을 불러오지 못했습니다.");
      return;
    }

    setOrders(result.data.orders);
    setTotalCount(result.data.totalCount);
    setHasMore(result.data.hasMore);
    setExternalOpenHrefs((prev) => ({ ...prev, ...result.data!.statementExternalOpenHrefByOrderId }));
    setEmptyNotice(
      result.data.orders.length === 0
        ? nextRangeDays !== null
          ? `최근 ${nextRangeDays}일간 발주 내역이 없습니다. 다른 기간을 선택해보세요.`
          : "아직 접수된 발주서가 없습니다."
        : null
    );
  };

  const handleLoadMore = async () => {
    if (isBusy) return;

    setMoreLoading(true);
    const result = await loadShopOrderHistoryPageAction(shopToken, rangeDays, orders.length);
    setMoreLoading(false);

    if (!result.success || !result.data) {
      return;
    }

    setOrders((prev) => [...prev, ...result.data!.orders]);
    setHasMore(result.data.hasMore);
    setExternalOpenHrefs((prev) => ({ ...prev, ...result.data!.statementExternalOpenHrefByOrderId }));
  };

  const openCancelForm = (orderId: string) => {
    setActiveOrderId(orderId);
    setReason("");
    setErrorMessage(null);
    setCompletedOrderId(null);
  };

  const closeCancelForm = () => {
    setActiveOrderId(null);
    setReason("");
    setErrorMessage(null);
  };

  const handleSubmit = async (order: ShopOrder) => {
    const reasonError = validateCancelReason(reason);

    if (reasonError) {
      setErrorMessage(reasonError);
      return;
    }

    setErrorMessage(null);
    setSubmittingOrderId(order.id);

    try {
      const result = await requestOrderCancelAction({
        shopToken,
        orderId: order.id,
        reason,
      });

      if (result.success) {
        setCompletedOrderId(order.id);
        closeCancelForm();
        // orders는 이제 클라이언트 상태(구간/더보기)로 관리되므로 router.refresh()로
        // 내려오는 새 서버 props가 반영되지 않는다 — 응답으로 받은 최신 상태를
        // 해당 주문에 직접 반영한다.
        setOrders((prev) =>
          prev.map((entry) =>
            entry.id === order.id
              ? {
                  ...entry,
                  status: result.status ?? "cancel_requested",
                  cancelReason: reason,
                  cancelRequestedAt: result.requestedAt ?? new Date().toISOString(),
                }
              : entry
          )
        );
      } else {
        setErrorMessage(result.error ?? "취소 요청 접수에 실패했습니다.");
      }
    } catch {
      setErrorMessage("취소 요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setSubmittingOrderId(null);
    }
  };

  return (
    <div style={shopPageStyle}>
      <ShopHeader
        wholesaler={wholesaler}
        customer={customer}
        title="내 발주 내역"
        backHref={`/shop/${shopToken}`}
      />

      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {!canPaginate && history.notice && (
          <div style={{ ...cardStyle, padding: "28px 20px", textAlign: "center" }}>
            <div style={{ fontSize: "32px", marginBottom: "10px" }}>
              {history.requiresLink ? "🔒" : "📋"}
            </div>
            <p style={{ fontSize: "13px", color: "#475569", lineHeight: 1.7 }}>{history.notice}</p>

            <Link
              href={`/shop/${shopToken}`}
              style={{
                display: "inline-block",
                marginTop: "18px",
                backgroundColor: "#0f172a",
                color: "#ffffff",
                fontSize: "13px",
                fontWeight: 700,
                padding: "11px 22px",
                borderRadius: "8px",
                textDecoration: "none",
              }}
            >
              상품 보러가기 →
            </Link>
          </div>
        )}

        {canPaginate && (
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
                  onClick={() => void handleRangeChange(option.days)}
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

        {canPaginate && emptyNotice && (
          <div style={{ ...cardStyle, padding: "20px", textAlign: "center" }}>
            <p style={{ fontSize: "13px", color: "#475569", lineHeight: 1.6 }}>
              {rangeLoading ? "불러오는 중..." : emptyNotice}
            </p>
          </div>
        )}

        {orders.map((order) => {
          const badge = ORDER_STATUS_BADGES[order.status];
          const progress = describeCancelProgress(order);
          const isCancelable = canRequestCancel(order.status);
          const isFormOpen = activeOrderId === order.id;
          const isSubmitting = submittingOrderId === order.id;

          return (
            <article key={order.id} style={{ ...cardStyle, padding: "16px" }}>
              {/* 주문 헤더 — 발주번호 / 접수시각 / 현재 상태 */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "10px",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <div style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>
                      {order.orderNumber}
                    </div>
                    {catalog.isDemo && <SampleBadge />}
                  </div>
                  <div style={{ fontSize: "12px", color: "#475569", marginTop: "3px" }}>
                    {formatOrderedAt(order.orderedAt)} 접수
                  </div>
                </div>

                <span
                  style={{
                    flexShrink: 0,
                    fontSize: "12px",
                    fontWeight: 700,
                    backgroundColor: badge.bg,
                    color: badge.color,
                    padding: "4px 9px",
                    borderRadius: "12px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {badge.label}
                </span>
              </div>

              {/* 발주 품목 — 발주 시점에 확정된 단가를 그대로 노출 */}
              <ul
                style={{
                  listStyle: "none",
                  margin: "14px 0 0",
                  padding: "12px 0 0",
                  borderTop: "1px solid #f1f5f9",
                  display: "flex",
                  flexDirection: "column",
                  gap: "7px",
                }}
              >
                {order.lines.map((line) => (
                  <li
                    key={line.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "10px",
                      fontSize: "13px",
                    }}
                  >
                    <span
                      style={{
                        color: "#334155",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        flexWrap: "wrap",
                      }}
                    >
                      {line.category && (
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            color: "#475569",
                            backgroundColor: "#f1f5f9",
                            padding: "1px 5px",
                            borderRadius: "4px",
                          }}
                        >
                          {line.category}
                        </span>
                      )}
                      {line.productName}
                      <span style={{ color: "#475569" }}>x {line.quantity}</span>
                    </span>
                    <span style={{ color: "#0f172a", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {formatWon(line.subtotalAmount)}
                    </span>
                  </li>
                ))}
              </ul>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: "12px",
                  paddingTop: "12px",
                  borderTop: "1px solid #f1f5f9",
                }}
              >
                <span style={{ fontSize: "13px", color: "#334155" }}>총 발주 금액</span>
                <strong style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>
                  {formatWon(order.totalAmount)}
                </strong>
              </div>

              <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
                <StatementPreviewButton
                  href={`/shop/${shopToken}/orders/${order.id}/statement`}
                  label="거래명세서"
                  externalOpenHref={externalOpenHrefs[order.id] ?? null}
                />
                {sweetTrackerConfigured && order.courierCode && order.trackingNumber && (
                  <TrackingLookupButton shopToken={shopToken} order={order} />
                )}
              </div>

              <p style={{ fontSize: "13px", color: "#475569", marginTop: "8px", lineHeight: 1.6 }}>
                배송지: {order.deliveryAddress || "-"}
                {order.deliveryNotes && (
                  <>
                    <br />
                    요청사항: {order.deliveryNotes}
                  </>
                )}
              </p>

              {/* 취소 요청 진행 상황 (요청 / 반려 / 취소 확정) */}
              {progress && (
                <div
                  style={{
                    marginTop: "12px",
                    backgroundColor: badge.bg,
                    color: badge.color,
                    fontSize: "13px",
                    lineHeight: 1.6,
                    padding: "10px 12px",
                    borderRadius: "8px",
                  }}
                >
                  {progress}
                  {order.cancelReason && (
                    <>
                      <br />
                      <strong>요청 사유:</strong> {order.cancelReason}
                    </>
                  )}
                  {order.cancelRequestedAt && (
                    <>
                      <br />
                      <span style={{ opacity: 0.8 }}>
                        요청 {formatOrderedAt(order.cancelRequestedAt)}
                        {order.cancelResolvedAt &&
                          ` · 처리 ${formatOrderedAt(order.cancelResolvedAt)}`}
                      </span>
                    </>
                  )}
                </div>
              )}

              {completedOrderId === order.id && (
                <div
                  style={{
                    marginTop: "12px",
                    backgroundColor: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                    color: "#166534",
                    fontSize: "13px",
                    lineHeight: 1.6,
                    padding: "10px 12px",
                    borderRadius: "8px",
                  }}
                >
                  ✓ 취소 요청이 접수되었습니다. {wholesaler.business_name} 대표님께 알림톡이 발송되었습니다.
                </div>
              )}

              {/* 취소 요청 버튼 → 사유 입력 폼 */}
              {isCancelable && !isFormOpen && (
                <button
                  type="button"
                  onClick={() => openCancelForm(order.id)}
                  style={{
                    width: "100%",
                    marginTop: "14px",
                    backgroundColor: "#ffffff",
                    color: "#b91c1c",
                    border: "1px solid #fecaca",
                    padding: "11px",
                    borderRadius: "8px",
                    fontSize: "13px",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  발주 취소 요청
                </button>
              )}

              {isFormOpen && (
                <div
                  style={{
                    marginTop: "14px",
                    paddingTop: "14px",
                    borderTop: "1px solid #f1f5f9",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  <div>
                    <label style={labelStyle} htmlFor={`cancel-reason-${order.id}`}>
                      취소 사유 *
                    </label>
                    <textarea
                      id={`cancel-reason-${order.id}`}
                      rows={3}
                      value={reason}
                      maxLength={CANCEL_REASON_MAX_LENGTH}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="예: 발주 수량을 잘못 입력했습니다."
                      style={{ ...inputStyle, resize: "vertical" }}
                    />
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        fontSize: "12px",
                        color: "#475569",
                        marginTop: "4px",
                      }}
                    >
                      {reason.trim().length} / {CANCEL_REASON_MAX_LENGTH}자
                    </div>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {REASON_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setReason(preset)}
                        style={{
                          backgroundColor: "#f1f5f9",
                          color: "#475569",
                          border: "none",
                          borderRadius: "12px",
                          padding: "6px 10px",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>

                  <div
                    style={{
                      backgroundColor: "#fffbeb",
                      border: "1px solid #fde68a",
                      color: "#92400e",
                      fontSize: "13px",
                      lineHeight: 1.6,
                      padding: "10px",
                      borderRadius: "8px",
                    }}
                  >
                    ⚠️ 취소 요청은 즉시 확정되지 않습니다. 이미 도축·분할 작업이 시작된 경우 공급사가 요청을
                    반려할 수 있습니다.
                  </div>

                  {errorMessage && (
                    <p
                      style={{
                        backgroundColor: "#fef2f2",
                        border: "1px solid #fecaca",
                        color: "#b91c1c",
                        fontSize: "13px",
                        padding: "10px",
                        borderRadius: "8px",
                      }}
                    >
                      {errorMessage}
                    </p>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={closeCancelForm}
                      disabled={isSubmitting}
                      style={{
                        backgroundColor: "#f1f5f9",
                        color: "#475569",
                        border: "none",
                        padding: "12px",
                        borderRadius: "8px",
                        fontSize: "13px",
                        fontWeight: 700,
                        cursor: isSubmitting ? "not-allowed" : "pointer",
                      }}
                    >
                      닫기
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSubmit(order)}
                      disabled={isSubmitting}
                      style={{
                        backgroundColor: isSubmitting ? "#cbd5e1" : "#dc2626",
                        color: "#ffffff",
                        border: "none",
                        padding: "12px",
                        borderRadius: "8px",
                        fontSize: "13px",
                        fontWeight: 700,
                        cursor: isSubmitting ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSubmitting ? "접수 중..." : "취소 요청 접수"}
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}

        {canPaginate && hasMore && (
          <button
            type="button"
            onClick={() => void handleLoadMore()}
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

      <ShopFooter businessName={wholesaler.business_name} />
    </div>
  );
}
