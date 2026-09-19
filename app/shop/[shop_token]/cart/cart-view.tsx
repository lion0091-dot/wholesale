"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useShopCart } from "@/lib/shop/cart-store";
import {
  MIN_ORDER_AMOUNT,
  lineSubtotal,
  quantityStepFor,
  validateCart,
} from "@/lib/shop/order-policy";
import { toCartLines, type ShopCatalog } from "@/lib/shop/catalog-types";
import {
  ShopFooter,
  ShopHeader,
  cardStyle,
  formatWon,
  shopPageStyle,
} from "../shop-chrome";

interface CartViewProps {
  catalog: ShopCatalog;
}

export function CartView({ catalog }: CartViewProps) {
  const { entries, isLoaded, stepQuantity, remove, clear } = useShopCart(catalog.shopToken);

  // 단가/재고는 매번 서버 카탈로그 기준으로 재계산한다 (공급사 단가 변경 즉시 반영)
  const lines = useMemo(
    () => (isLoaded ? toCartLines(catalog, entries) : []),
    [catalog, entries, isLoaded]
  );

  const validation = useMemo(() => validateCart(lines), [lines]);
  const { totals, shortfallAmount } = validation;
  const blockingMessages = validation.violations.filter((violation) => violation.code !== "empty");

  return (
    <div style={{ ...shopPageStyle, paddingBottom: lines.length > 0 ? "120px" : "20px" }}>
      <ShopHeader
        wholesaler={catalog.wholesaler}
        customer={catalog.customer}
        title="발주 장바구니"
        backHref={`/shop/${catalog.shopToken}`}
      />

      <div style={{ padding: "16px" }}>
        {!isLoaded ? (
          <p style={{ fontSize: "13px", color: "#334155", textAlign: "center", padding: "40px 0" }}>
            장바구니를 불러오는 중...
          </p>
        ) : lines.length === 0 ? (
          <div
            style={{
              ...cardStyle,
              borderStyle: "dashed",
              borderColor: "#cbd5e1",
              padding: "48px 20px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "28px", marginBottom: "10px" }}>🧺</div>
            <p style={{ fontSize: "14px", color: "#334155", marginBottom: "20px" }}>
              장바구니가 비어 있습니다.
            </p>
            <Link
              href={`/shop/${catalog.shopToken}`}
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
        ) : (
          <>
            <div style={{ display: "grid", gap: "10px" }}>
              {lines.map((line) => {
                const step = quantityStepFor(line.unit);

                return (
                  <div key={line.productId} style={{ ...cardStyle, padding: "14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                      <div>
                        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                          {line.name}
                          {line.isSecretDeal && (
                            <span style={{ fontSize: "12px", color: "#b91c1c", marginLeft: "6px" }}>
                              시크릿 특가
                            </span>
                          )}
                        </h3>
                        <p style={{ fontSize: "12px", color: "#334155", marginTop: "3px" }}>
                          {formatWon(line.unitPrice)} / {line.unit}
                          {line.isCustomPrice && (
                            <span style={{ color: "#166534", fontWeight: 700, marginLeft: "6px" }}>
                              맞춤 단가
                            </span>
                          )}
                        </p>
                      </div>

                      <button
                        onClick={() => remove(line.productId)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#475569",
                          fontSize: "12px",
                          cursor: "pointer",
                          alignSelf: "flex-start",
                        }}
                      >
                        삭제
                      </button>
                    </div>

                    <div
                      style={{
                        marginTop: "12px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          backgroundColor: "#f1f5f9",
                          padding: "4px 8px",
                          borderRadius: "8px",
                        }}
                      >
                        <button
                          onClick={() =>
                            stepQuantity(line.productId, -1, line.unit, line.stockQuantity)
                          }
                          style={stepButtonStyle(false)}
                        >
                          -
                        </button>
                        <span style={{ fontSize: "14px", fontWeight: 700, minWidth: "56px", textAlign: "center" }}>
                          {line.quantity} {line.unit}
                        </span>
                        <button
                          onClick={() =>
                            stepQuantity(line.productId, 1, line.unit, line.stockQuantity)
                          }
                          disabled={line.quantity >= line.stockQuantity}
                          style={stepButtonStyle(line.quantity >= line.stockQuantity)}
                        >
                          +
                        </button>
                      </div>

                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>
                          {formatWon(lineSubtotal(line))}
                        </div>
                        <div style={{ fontSize: "12px", color: "#475569" }}>
                          {step}{line.unit} 단위 · 재고 {line.stockQuantity}{line.unit}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={clear}
              style={{
                marginTop: "12px",
                width: "100%",
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                color: "#334155",
                fontSize: "13px",
                fontWeight: 600,
                padding: "10px",
                borderRadius: "8px",
                cursor: "pointer",
              }}
            >
              장바구니 비우기
            </button>

            {/* 금액 요약 */}
            <div style={{ ...cardStyle, padding: "16px", marginTop: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", color: "#475569" }}>
                <span>담은 품목</span>
                <span>
                  {totals.itemCount}건 / 총 {totals.totalQuantity}
                </span>
              </div>

              {totals.savedAmount > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "13px",
                    color: "#166534",
                    marginTop: "6px",
                  }}
                >
                  <span>단골 맞춤 단가 절감액</span>
                  <span>- {formatWon(totals.savedAmount)}</span>
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  borderTop: "1px solid #e2e8f0",
                  marginTop: "10px",
                  paddingTop: "10px",
                }}
              >
                <span style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>총 주문 금액</span>
                <span style={{ fontSize: "20px", fontWeight: 800, color: "#dc2626" }}>
                  {formatWon(totals.totalAmount)}
                </span>
              </div>

              <p style={{ fontSize: "12px", color: "#475569", marginTop: "8px" }}>
                최소 주문 금액 {MIN_ORDER_AMOUNT.toLocaleString()}원 (부가세 별도, 배송비는 공급사 정책에 따름)
              </p>
            </div>

            {/* 최소 주문 금액/수량·재고 미충족 안내 */}
            {blockingMessages.length > 0 && (
              <div
                style={{
                  backgroundColor: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: "8px",
                  padding: "12px",
                  marginTop: "12px",
                }}
              >
                {blockingMessages.map((violation, index) => (
                  <p
                    key={`${violation.code}-${violation.productId ?? index}`}
                    style={{ fontSize: "12px", color: "#b91c1c", lineHeight: 1.6 }}
                  >
                    • {violation.message}
                  </p>
                ))}

                {shortfallAmount > 0 && (
                  <div
                    style={{
                      marginTop: "8px",
                      height: "6px",
                      backgroundColor: "#fee2e2",
                      borderRadius: "999px",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, (totals.totalAmount / MIN_ORDER_AMOUNT) * 100)}%`,
                        height: "100%",
                        backgroundColor: "#dc2626",
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 하단 고정 주문서 작성 바 */}
      {lines.length > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: "50%",
            transform: "translateX(-50%)",
            width: "100%",
            maxWidth: "600px",
            backgroundColor: "#ffffff",
            borderTop: "1px solid #e2e8f0",
            padding: "12px 16px",
            zIndex: 30,
          }}
        >
          {validation.ok ? (
            <Link
              href={`/shop/${catalog.shopToken}/checkout`}
              style={{
                display: "block",
                textAlign: "center",
                backgroundColor: "#0f172a",
                color: "#ffffff",
                fontSize: "15px",
                fontWeight: 700,
                padding: "14px",
                borderRadius: "10px",
                textDecoration: "none",
              }}
            >
              {formatWon(totals.totalAmount)} 주문서 작성하기 →
            </Link>
          ) : (
            <button
              disabled
              style={{
                width: "100%",
                backgroundColor: "#cbd5e1",
                color: "#ffffff",
                fontSize: "15px",
                fontWeight: 700,
                padding: "14px",
                borderRadius: "10px",
                border: "none",
                cursor: "not-allowed",
              }}
            >
              {shortfallAmount > 0
                ? `${formatWon(shortfallAmount)} 더 담으면 발주 가능`
                : "발주 조건을 확인해주세요"}
            </button>
          )}
        </div>
      )}

      <ShopFooter businessName={catalog.wholesaler.business_name} />
    </div>
  );
}

function stepButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: "28px",
    height: "28px",
    borderRadius: "6px",
    border: "1px solid #cbd5e1",
    backgroundColor: disabled ? "#f8fafc" : "#ffffff",
    color: disabled ? "#cbd5e1" : "#0f172a",
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 800,
  };
}
