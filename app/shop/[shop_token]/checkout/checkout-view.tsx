"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useShopCart } from "@/lib/shop/cart-store";
import { MIN_ORDER_AMOUNT, lineSubtotal, validateCart } from "@/lib/shop/order-policy";
import { toCartLines, type ShopCatalog } from "@/lib/shop/catalog-types";
import {
  ShopFooter,
  ShopHeader,
  cardStyle,
  formatWon,
  inputStyle,
  labelStyle,
  shopPageStyle,
} from "../shop-chrome";
import { submitOrderAction } from "../actions";

interface CheckoutViewProps {
  catalog: ShopCatalog;
}

interface OrderReceipt {
  orderNumber: string;
  totalAmount: number;
  itemsSummary: string;
  notificationId?: string;
  isDemo?: boolean;
}

export function CheckoutView({ catalog }: CheckoutViewProps) {
  const { customer, wholesaler, shopToken } = catalog;
  const { entries, isLoaded, clear } = useShopCart(shopToken);

  const [restaurantName, setRestaurantName] = useState(customer.restaurantName ?? "");
  const [contactPhone, setContactPhone] = useState(customer.contactPhone ?? "");
  const [deliveryAddress, setDeliveryAddress] = useState(customer.deliveryAddress ?? "");
  const [deliveryNotes, setDeliveryNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<OrderReceipt | null>(null);

  const lines = useMemo(
    () => (isLoaded ? toCartLines(catalog, entries) : []),
    [catalog, entries, isLoaded]
  );

  const validation = useMemo(() => validateCart(lines), [lines]);
  const { totals } = validation;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);

    if (!validation.ok) {
      setErrorMessage(validation.violations[0].message);
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await submitOrderAction({
        shopToken,
        items: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        restaurantName,
        contactPhone,
        deliveryAddress,
        deliveryNotes,
      });

      if (result.success && result.orderNumber) {
        setReceipt({
          orderNumber: result.orderNumber,
          totalAmount: result.totalAmount ?? totals.totalAmount,
          itemsSummary: result.itemsSummary ?? "",
          notificationId: result.notificationId,
          isDemo: result.isDemo,
        });
        clear();
      } else {
        setErrorMessage(result.error ?? "발주서 접수에 실패했습니다.");
      }
    } catch {
      setErrorMessage("발주서 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // 발주 완료 화면
  if (receipt) {
    return (
      <div style={shopPageStyle}>
        <ShopHeader wholesaler={wholesaler} customer={customer} title="발주 완료" />

        <div style={{ padding: "16px" }}>
          <div style={{ ...cardStyle, padding: "28px 20px", textAlign: "center" }}>
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>🎉</div>
            <h2 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", marginBottom: "8px" }}>
              발주서가 접수되었습니다!
            </h2>
            <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6, marginBottom: "18px" }}>
              {wholesaler.business_name} 대표님께 카카오 알림톡이 발송되었습니다.
              <br />
              출고 확정 시 다시 안내드립니다.
            </p>

            <div
              style={{
                backgroundColor: "#f8fafc",
                padding: "14px",
                borderRadius: "8px",
                fontSize: "13px",
                textAlign: "left",
                lineHeight: 1.8,
              }}
            >
              <div>
                <strong>주문 번호:</strong> {receipt.orderNumber}
              </div>
              <div>
                <strong>발주 내역:</strong> {receipt.itemsSummary}
              </div>
              <div>
                <strong>총 주문 금액:</strong> {formatWon(receipt.totalAmount)}
              </div>
              <div>
                <strong>배송지:</strong> {deliveryAddress}
              </div>
              {receipt.notificationId && (
                <div style={{ color: "#166534" }}>
                  <strong>알림톡 발송 ID:</strong> {receipt.notificationId}
                </div>
              )}
            </div>

            {receipt.isDemo && (
              <p style={{ fontSize: "11px", color: "#92400e", marginTop: "10px", textAlign: "left" }}>
                * 시연 모드로 접수되어 알림톡 포맷만 검증되었으며 실제 주문 내역은 저장되지 않았습니다.
              </p>
            )}

            <Link
              href={`/shop/${shopToken}`}
              style={{
                display: "block",
                marginTop: "20px",
                backgroundColor: "#0f172a",
                color: "#ffffff",
                fontSize: "14px",
                fontWeight: 700,
                padding: "13px",
                borderRadius: "8px",
                textDecoration: "none",
              }}
            >
              미니샵으로 돌아가기
            </Link>
          </div>
        </div>

        <ShopFooter businessName={wholesaler.business_name} />
      </div>
    );
  }

  // 장바구니가 비었거나 조건 미충족 시 장바구니로 유도
  if (isLoaded && lines.length === 0) {
    return (
      <div style={shopPageStyle}>
        <ShopHeader
          wholesaler={wholesaler}
          customer={customer}
          title="주문서 작성"
          backHref={`/shop/${shopToken}/cart`}
        />

        <div style={{ padding: "16px" }}>
          <div
            style={{
              ...cardStyle,
              borderStyle: "dashed",
              borderColor: "#cbd5e1",
              padding: "48px 20px",
              textAlign: "center",
            }}
          >
            <p style={{ fontSize: "14px", color: "#64748b", marginBottom: "20px" }}>
              발주할 품목이 없습니다. 먼저 품목을 담아주세요.
            </p>
            <Link
              href={`/shop/${shopToken}`}
              style={{
                display: "inline-block",
                backgroundColor: "#0f172a",
                color: "#ffffff",
                fontSize: "14px",
                fontWeight: 700,
                padding: "12px 24px",
                borderRadius: "8px",
                textDecoration: "none",
              }}
            >
              납품 품목 보러가기
            </Link>
          </div>
        </div>

        <ShopFooter businessName={wholesaler.business_name} />
      </div>
    );
  }

  return (
    <div style={{ ...shopPageStyle, paddingBottom: "20px" }}>
      <ShopHeader
        wholesaler={wholesaler}
        customer={customer}
        title="주문서 작성"
        backHref={`/shop/${shopToken}/cart`}
      />

      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* 발주 품목 확인 */}
        <div style={{ ...cardStyle, padding: "16px" }}>
          <span style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>
            발주 품목 ({totals.itemCount})
          </span>

          <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {lines.map((line) => (
              <div
                key={line.productId}
                style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", gap: "8px" }}
              >
                <span style={{ color: "#334155" }}>
                  {line.name} × {line.quantity}
                  {line.unit}
                  {line.isCustomPrice && (
                    <span style={{ color: "#166534", fontSize: "11px", marginLeft: "4px" }}>맞춤</span>
                  )}
                </span>
                <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
                  {formatWon(lineSubtotal(line))}
                </span>
              </div>
            ))}
          </div>

          <div
            style={{
              borderTop: "1px solid #e2e8f0",
              marginTop: "12px",
              paddingTop: "10px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <span style={{ fontSize: "14px", fontWeight: 800 }}>총 주문 금액</span>
            <span style={{ fontSize: "20px", fontWeight: 800, color: "#dc2626" }}>
              {formatWon(totals.totalAmount)}
            </span>
          </div>

          <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "6px" }}>
            최소 주문 금액 {MIN_ORDER_AMOUNT.toLocaleString()}원 · 부가세 별도
          </p>
        </div>

        {/* 배송지 확인 및 요청사항 */}
        <form onSubmit={handleSubmit} style={{ ...cardStyle, padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <h2 style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>배송 정보 확인</h2>

          <div>
            <label style={labelStyle} htmlFor="restaurant-name">
              구매 사업장(상호)명 *
            </label>
            <input
              id="restaurant-name"
              type="text"
              required
              value={restaurantName}
              onChange={(event) => setRestaurantName(event.target.value)}
              placeholder="예: 을지로 미트하우스"
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle} htmlFor="contact-phone">
              담당자 연락처 *
            </label>
            <input
              id="contact-phone"
              type="tel"
              required
              value={contactPhone}
              onChange={(event) => setContactPhone(event.target.value)}
              placeholder="010-0000-0000"
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle} htmlFor="delivery-address">
              배송지 주소 *
            </label>
            <input
              id="delivery-address"
              type="text"
              required
              value={deliveryAddress}
              onChange={(event) => setDeliveryAddress(event.target.value)}
              placeholder="예: 서울 성동구 마장로 23길 10, 1층 주방"
              style={inputStyle}
            />
            {customer.deliveryAddress && (
              <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>
                등록된 기본 배송지가 입력되어 있습니다. 필요 시 수정하세요.
              </p>
            )}
          </div>

          <div>
            <label style={labelStyle} htmlFor="delivery-notes">
              배송 요청사항 / 메모
            </label>
            <textarea
              id="delivery-notes"
              rows={3}
              value={deliveryNotes}
              onChange={(event) => setDeliveryNotes(event.target.value)}
              placeholder="예: 새벽 6시 전 주방 문 앞 보냉박스 보관"
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>

          <div
            style={{
              backgroundColor: "#eff6ff",
              border: "1px solid #bfdbfe",
              padding: "10px",
              borderRadius: "8px",
              fontSize: "12px",
              color: "#1e40af",
              lineHeight: 1.6,
            }}
          >
            ℹ️ 발주서 전송 즉시 <strong>{wholesaler.business_name}</strong> 대표님께 카카오 알림톡이 발송됩니다.
            최종 단가는 공급사 확인 시점의 계약 단가로 확정됩니다.
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

          <button
            type="submit"
            disabled={isSubmitting || !validation.ok}
            style={{
              backgroundColor: isSubmitting || !validation.ok ? "#cbd5e1" : "#0f172a",
              color: "#ffffff",
              padding: "14px",
              borderRadius: "8px",
              fontSize: "15px",
              fontWeight: 700,
              border: "none",
              cursor: isSubmitting || !validation.ok ? "not-allowed" : "pointer",
              marginTop: "4px",
            }}
          >
            {isSubmitting ? "발주서 접수 및 알림톡 발송 중..." : "도매처로 발주서 최종 전송"}
          </button>
        </form>
      </div>

      <ShopFooter businessName={wholesaler.business_name} />
    </div>
  );
}
