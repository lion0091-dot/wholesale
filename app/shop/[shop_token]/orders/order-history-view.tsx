"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ORDER_STATUS_BADGES, canRequestCancel, formatOrderedAt } from "@/lib/orders/status";
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
import { fetchBuyerTrackingStatusAction, requestOrderCancelAction } from "../actions";
import { StatementPreviewButton } from "@/components/statement-preview-button";
import { SampleBadge } from "@/components/sample-badge";
import { courierLabel, type TrackingResult } from "@/lib/verification/sweettracker";

interface OrderHistoryViewProps {
  catalog: ShopCatalog;
  history: ShopOrderHistory;
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
          fontSize: "12px",
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
        <div style={{ marginTop: "8px", fontSize: "12px" }}>
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
  sweetTrackerConfigured,
  statementExternalOpenHrefByOrderId,
}: OrderHistoryViewProps) {
  const router = useRouter();
  const { wholesaler, customer, shopToken } = catalog;

  /** 취소 사유 입력창이 열린 주문 ID */
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submittingOrderId, setSubmittingOrderId] = useState<string | null>(null);
  const [completedOrderId, setCompletedOrderId] = useState<string | null>(null);

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
        // 서버 컴포넌트를 다시 불러 상태 배지/요청 사유를 최신값으로 교체한다.
        router.refresh();
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
        {history.notice && (
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

        {history.orders.map((order) => {
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
                      fontSize: "12px",
                    }}
                  >
                    <span style={{ color: "#334155" }}>
                      {line.productName}
                      <span style={{ color: "#475569" }}> x {line.quantity}</span>
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
                <span style={{ fontSize: "12px", color: "#334155" }}>총 발주 금액</span>
                <strong style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>
                  {formatWon(order.totalAmount)}
                </strong>
              </div>

              <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
                <StatementPreviewButton
                  href={`/shop/${shopToken}/orders/${order.id}/statement`}
                  label="거래명세서"
                  externalOpenHref={statementExternalOpenHrefByOrderId[order.id] ?? null}
                />
                {sweetTrackerConfigured && order.courierCode && order.trackingNumber && (
                  <TrackingLookupButton shopToken={shopToken} order={order} />
                )}
              </div>

              <p style={{ fontSize: "12px", color: "#475569", marginTop: "8px", lineHeight: 1.6 }}>
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
                    fontSize: "12px",
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
                    fontSize: "12px",
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
                  주문 취소 요청
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
                      fontSize: "12px",
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
                        fontSize: "12px",
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
      </div>

      <ShopFooter businessName={wholesaler.business_name} />
    </div>
  );
}
