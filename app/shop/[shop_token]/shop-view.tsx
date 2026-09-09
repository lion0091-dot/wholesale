"use client";

import { useState } from "react";
import type { Product, Wholesaler } from "@/types/database";
import { createOrderAction } from "./actions";

interface ShopViewProps {
  wholesaler: Wholesaler;
  products: Product[];
  isLoggedIn: boolean;
  restaurantName?: string | null;
}

interface CartItem {
  product: Product;
  quantity: number;
}

export function ShopView({ wholesaler, products, isLoggedIn, restaurantName }: ShopViewProps) {
  const [activeTab, setActiveTab] = useState<"normal" | "secret">("normal");
  const [selectedCategory, setSelectedCategory] = useState<string>("전체");

  // 장바구니 상태
  const [cart, setCart] = useState<Record<string, CartItem>>({});
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [orderCompleteResult, setOrderCompleteResult] = useState<{
    orderNumber: string;
    notificationId?: string;
  } | null>(null);

  // 주문서 입력 폼 상태
  const [formRestaurantName, setFormRestaurantName] = useState(restaurantName || "을지로 미트하우스 (구매 회원)");
  const [formContactPhone, setFormContactPhone] = useState("010-9876-5432");
  const [formDeliveryAddress, setFormDeliveryAddress] = useState("서울 성동구 마장로 23길 10, 1층 주방");
  const [formDeliveryNotes, setFormDeliveryNotes] = useState("내일 오전 6시 전 주방 문 앞 보냉박스 보관 요망");

  const categories = ["전체", "소", "돼지", "닭/오리", "가공육/기타"];

  // 탭에 따라 상품 필터링
  const tabFilteredProducts = products.filter((p) =>
    activeTab === "normal" ? !p.is_secret_deal : p.is_secret_deal
  );

  // 카테고리 필터링
  const displayedProducts = tabFilteredProducts.filter((p) => {
    if (selectedCategory === "전체") return true;
    if (selectedCategory === "가공육/기타") return !["소", "돼지", "닭/오리"].includes(p.category);
    return p.category === selectedCategory;
  });

  // 장바구니 핸들러
  const handleAddToCart = (product: Product) => {
    setCart((prev) => {
      const existing = prev[product.id];
      const newQty = existing ? existing.quantity + 1 : 1;
      return {
        ...prev,
        [product.id]: { product, quantity: newQty },
      };
    });
  };

  const handleUpdateQuantity = (productId: string, delta: number) => {
    setCart((prev) => {
      const existing = prev[productId];
      if (!existing) return prev;
      const newQty = existing.quantity + delta;
      if (newQty <= 0) {
        const next = { ...prev };
        delete next[productId];
        return next;
      }
      return {
        ...prev,
        [productId]: { ...existing, quantity: newQty },
      };
    });
  };

  // 계산
  const cartItemsList = Object.values(cart);
  const totalCartCount = cartItemsList.reduce((acc, item) => acc + item.quantity, 0);
  const totalCartAmount = cartItemsList.reduce(
    (acc, item) => acc + item.product.base_price * item.quantity,
    0
  );

  // 발주서 제출 핸들러
  const handleOrderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cartItemsList.length === 0) {
      alert("장바구니가 비어 있습니다.");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await createOrderAction({
        shopToken: wholesaler.shop_token,
        wholesalerId: wholesaler.id,
        wholesalerName: wholesaler.business_name,
        restaurantName: formRestaurantName,
        contactPhone: formContactPhone,
        deliveryAddress: formDeliveryAddress,
        deliveryNotes: formDeliveryNotes,
        items: cartItemsList.map((item) => ({
          productId: item.product.id,
          productName: item.product.name,
          unitPrice: item.product.base_price,
          quantity: item.quantity,
          unit: item.product.unit,
          subtotalAmount: item.product.base_price * item.quantity,
        })),
        totalAmount: totalCartAmount,
      });

      if (result.success && result.orderNumber) {
        setOrderCompleteResult({
          orderNumber: result.orderNumber,
          notificationId: result.notificationId,
        });
        setCart({}); // 장바구니 비우기
      } else {
        alert(result.error || "발주서 접수에 실패했습니다.");
      }
    } catch {
      alert("발주서 처리 중 오류가 발생했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: "600px", margin: "0 auto", minHeight: "100vh", backgroundColor: "#f8fafc", paddingBottom: totalCartCount > 0 ? "90px" : "20px" }}>
      {/* 도매업체 헤더 */}
      <header
        style={{
          backgroundColor: "#ffffff",
          padding: "20px 16px",
          borderBottom: "1px solid #e2e8f0",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <span style={{ fontSize: "11px", fontWeight: 700, color: "#dc2626", letterSpacing: "0.5px" }}>
              단골 전용 1:1 직거래 발주
            </span>
            <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", marginTop: "2px" }}>
              {wholesaler.business_name}
            </h1>
            <p style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
              대표자: {wholesaler.representative_name} | 사업자번호: {wholesaler.business_number}
            </p>
          </div>

          <div style={{ textAlign: "right" }}>
            {isLoggedIn ? (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  backgroundColor: "#dcfce7",
                  color: "#166534",
                  padding: "4px 8px",
                  borderRadius: "12px",
                }}
              >
                {restaurantName || "인증 바이어"} 접속중
              </span>
            ) : (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  backgroundColor: "#f1f5f9",
                  color: "#475569",
                  padding: "4px 8px",
                  borderRadius: "12px",
                }}
              >
                미인증 손님 모드
              </span>
            )}
          </div>
        </div>

        {/* 탭 전환 (일반 상품 vs 시크릿 딜 룸) */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "16px" }}>
          <button
            onClick={() => setActiveTab("normal")}
            style={{
              padding: "10px",
              borderRadius: "8px",
              border: "none",
              fontSize: "14px",
              fontWeight: 700,
              cursor: "pointer",
              backgroundColor: activeTab === "normal" ? "#0f172a" : "#f1f5f9",
              color: activeTab === "normal" ? "#ffffff" : "#64748b",
              transition: "all 0.15s ease",
            }}
          >
            기본 납품 품목
          </button>
          <button
            onClick={() => setActiveTab("secret")}
            style={{
              padding: "10px",
              borderRadius: "8px",
              border: "none",
              fontSize: "14px",
              fontWeight: 700,
              cursor: "pointer",
              backgroundColor: activeTab === "secret" ? "#dc2626" : "#fee2e2",
              color: activeTab === "secret" ? "#ffffff" : "#b91c1c",
              transition: "all 0.15s ease",
            }}
          >
            🔥 시크릿 특가 룸
          </button>
        </div>
      </header>

      {/* 본문 콘텐츠 영역 */}
      <div style={{ padding: "16px" }}>
        {/* 옵션 B: 비로그인 상태에서 시크릿 딜 탭 클릭 시 안내 배너 */}
        {activeTab === "secret" && !isLoggedIn ? (
          <div
            style={{
              backgroundColor: "#ffffff",
              padding: "36px 20px",
              borderRadius: "12px",
              textAlign: "center",
              border: "1px solid #fecaca",
              boxShadow: "0 2px 4px rgba(0,0,0,0.03)",
              marginTop: "20px",
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>🔒</div>
            <h3 style={{ fontSize: "17px", fontWeight: 700, color: "#991b1b", marginBottom: "6px" }}>
              바이어(구매 회원) 전용 시크릿 딜 룸
            </h3>
            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.6", marginBottom: "20px" }}>
              정규 시장 가격 붕괴를 방지하기 위해 <strong>인증된 구매 회원(바이어)</strong>에게만 한정 수량 당일 마감 특가 고기가 공개됩니다.
            </p>
            <button
              onClick={() => alert("로그인 세션 연결 시 단골 전용 특가 구매가 활성화됩니다.")}
              style={{
                backgroundColor: "#fee500",
                color: "#181600",
                fontWeight: 700,
                fontSize: "14px",
                padding: "12px 24px",
                borderRadius: "8px",
                border: "none",
                cursor: "pointer",
                boxShadow: "0 2px 4px rgba(0,0,0,0.05)",
              }}
            >
              카카오 1초 로그인하고 특가 보기
            </button>
          </div>
        ) : (
          <>
            {/* 카테고리 필터 바 */}
            <div style={{ display: "flex", gap: "6px", overflowX: "auto", paddingBottom: "12px", marginBottom: "12px" }}>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "20px",
                    border: "1px solid",
                    borderColor: selectedCategory === cat ? "#0f172a" : "#e2e8f0",
                    backgroundColor: selectedCategory === cat ? "#0f172a" : "#ffffff",
                    color: selectedCategory === cat ? "#ffffff" : "#475569",
                    fontSize: "12px",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* 상품 카드 목록 */}
            {displayedProducts.length === 0 ? (
              <div style={{ textAlign: "center", padding: "48px 16px", background: "#ffffff", borderRadius: "12px", border: "1px dashed #cbd5e1" }}>
                <p style={{ color: "#64748b", fontSize: "14px" }}>현재 등록된 상품이 없습니다.</p>
              </div>
            ) : (
              <div style={{ display: "grid", gap: "12px" }}>
                {displayedProducts.map((product) => {
                  const cartItem = cart[product.id];
                  const inCartQty = cartItem ? cartItem.quantity : 0;

                  return (
                    <div
                      key={product.id}
                      style={{
                        backgroundColor: "#ffffff",
                        borderRadius: "12px",
                        padding: "16px",
                        border: inCartQty > 0 ? "1px solid #0f172a" : "1px solid #e2e8f0",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <span
                              style={{
                                fontSize: "11px",
                                fontWeight: 700,
                                color: product.is_secret_deal ? "#b91c1c" : "#475569",
                                backgroundColor: product.is_secret_deal ? "#fee2e2" : "#f1f5f9",
                                padding: "2px 6px",
                                borderRadius: "4px",
                              }}
                            >
                              {product.category}
                            </span>
                            <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>{product.name}</h3>
                          </div>
                          <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                            원산지: {product.origin} {product.grade ? `| 등급: ${product.grade}` : ""}
                          </p>
                        </div>

                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: "17px", fontWeight: 800, color: product.is_secret_deal ? "#dc2626" : "#0f172a" }}>
                            {Number(product.base_price).toLocaleString()}원
                            <span style={{ fontSize: "12px", fontWeight: 400, color: "#64748b", marginLeft: "2px" }}>/ {product.unit}</span>
                          </div>
                          <div style={{ fontSize: "11px", color: product.stock_quantity > 0 ? "#166534" : "#dc2626", fontWeight: 600, marginTop: "2px" }}>
                            {product.stock_quantity > 0 ? `남은 수량: ${product.stock_quantity} ${product.unit}` : "품절"}
                          </div>
                        </div>
                      </div>

                      {product.description && (
                        <p style={{ fontSize: "12px", color: "#64748b", backgroundColor: "#f8fafc", padding: "8px", borderRadius: "6px", marginTop: "8px" }}>
                          {product.description}
                        </p>
                      )}

                      {/* 발주 수량 조절 및 담기 인터랙션 */}
                      <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #f1f5f9", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px" }}>
                        {inCartQty > 0 ? (
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", backgroundColor: "#f1f5f9", padding: "4px 8px", borderRadius: "8px" }}>
                            <button
                              onClick={() => handleUpdateQuantity(product.id, -1)}
                              style={{
                                width: "28px",
                                height: "28px",
                                borderRadius: "6px",
                                border: "1px solid #cbd5e1",
                                backgroundColor: "#ffffff",
                                cursor: "pointer",
                                fontWeight: 800,
                              }}
                            >
                              -
                            </button>
                            <span style={{ fontSize: "14px", fontWeight: 700, minWidth: "36px", textAlign: "center" }}>
                              {inCartQty} {product.unit}
                            </span>
                            <button
                              onClick={() => handleUpdateQuantity(product.id, 1)}
                              style={{
                                width: "28px",
                                height: "28px",
                                borderRadius: "6px",
                                border: "1px solid #cbd5e1",
                                backgroundColor: "#ffffff",
                                cursor: "pointer",
                                fontWeight: 800,
                              }}
                            >
                              +
                            </button>
                          </div>
                        ) : (
                          <button
                            disabled={product.stock_quantity <= 0}
                            onClick={() => handleAddToCart(product)}
                            style={{
                              backgroundColor: product.stock_quantity > 0 ? "#0f172a" : "#cbd5e1",
                              color: "#ffffff",
                              fontSize: "13px",
                              fontWeight: 600,
                              padding: "8px 16px",
                              borderRadius: "6px",
                              border: "none",
                              cursor: product.stock_quantity > 0 ? "pointer" : "not-allowed",
                            }}
                          >
                            {product.stock_quantity > 0 ? "+ 발주 담기" : "품절"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* 하단 플로팅 장바구니 바 (장바구니에 담긴 물품이 있을 때 노출) */}
      {totalCartCount > 0 && !isCheckoutOpen && (
        <div
          style={{
            position: "fixed",
            bottom: "16px",
            left: "50%",
            transform: "translateX(-50%)",
            width: "calc(100% - 32px)",
            maxWidth: "568px",
            backgroundColor: "#0f172a",
            color: "#ffffff",
            borderRadius: "16px",
            padding: "14px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            boxShadow: "0 10px 25px -5px rgba(0,0,0,0.3)",
            zIndex: 30,
          }}
        >
          <div>
            <span style={{ fontSize: "12px", color: "#94a3b8" }}>담은 품목 {totalCartCount}건</span>
            <div style={{ fontSize: "17px", fontWeight: 800 }}>
              {totalCartAmount.toLocaleString()}원
            </div>
          </div>

          <button
            onClick={() => setIsCheckoutOpen(true)}
            style={{
              backgroundColor: "#dc2626",
              color: "#ffffff",
              fontSize: "14px",
              fontWeight: 700,
              padding: "10px 20px",
              borderRadius: "10px",
              border: "none",
              cursor: "pointer",
            }}
          >
            발주서 작성하기 →
          </button>
        </div>
      )}

      {/* 발주서 작성 및 전송 모달 */}
      {isCheckoutOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            zIndex: 40,
          }}
        >
          <div
            style={{
              backgroundColor: "#ffffff",
              width: "100%",
              maxWidth: "600px",
              borderTopLeftRadius: "20px",
              borderTopRightRadius: "20px",
              maxHeight: "90vh",
              overflowY: "auto",
              padding: "24px 20px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>
                📝 발주서 확인 및 전송
              </h2>
              <button
                onClick={() => setIsCheckoutOpen(false)}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: "20px",
                  cursor: "pointer",
                  color: "#64748b",
                }}
              >
                ✕
              </button>
            </div>

            {/* 주문 품목 요약 */}
            <div style={{ backgroundColor: "#f8fafc", borderRadius: "10px", padding: "12px", marginBottom: "20px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>발주 품목 ({cartItemsList.length})</span>
              <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
                {cartItemsList.map((item) => (
                  <div key={item.product.id} style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                    <span>{item.product.name} × {item.quantity}{item.product.unit}</span>
                    <span style={{ fontWeight: 700 }}>
                      {(item.product.base_price * item.quantity).toLocaleString()}원
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ borderTop: "1px solid #e2e8f0", marginTop: "10px", paddingTop: "8px", display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: "15px" }}>
                <span>총 주문 금액</span>
                <span style={{ color: "#dc2626" }}>{totalCartAmount.toLocaleString()}원</span>
              </div>
            </div>

            {/* 바이어 배송 정보 입력 폼 */}
            <form onSubmit={handleOrderSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                  구매 사업장(상호)명 *
                </label>
                <input
                  type="text"
                  required
                  value={formRestaurantName}
                  onChange={(e) => setFormRestaurantName(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                  담당자 연락처 *
                </label>
                <input
                  type="text"
                  required
                  value={formContactPhone}
                  onChange={(e) => setFormContactPhone(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                  배송지 주소 *
                </label>
                <input
                  type="text"
                  required
                  value={formDeliveryAddress}
                  onChange={(e) => setFormDeliveryAddress(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                  배송 요청사항 / 메모
                </label>
                <textarea
                  rows={2}
                  value={formDeliveryNotes}
                  onChange={(e) => setFormDeliveryNotes(e.target.value)}
                  placeholder="예: 새벽 6시 전 주방 문 앞 보냉박스 보관"
                  style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
                />
              </div>

              <div style={{ backgroundColor: "#eff6ff", border: "1px solid #bfdbfe", padding: "10px", borderRadius: "8px", fontSize: "12px", color: "#1e40af" }}>
                ℹ️ 발주서 전송 즉시 <strong>{wholesaler.business_name}</strong> 대표님께 카카오 알림톡이 전송됩니다.
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                style={{
                  backgroundColor: "#0f172a",
                  color: "#ffffff",
                  padding: "14px",
                  borderRadius: "8px",
                  fontSize: "15px",
                  fontWeight: 700,
                  border: "none",
                  cursor: isSubmitting ? "not-allowed" : "pointer",
                  marginTop: "8px",
                }}
              >
                {isSubmitting ? "발주서 접수 및 알림톡 발송 중..." : "도매처로 발주서 최종 전송"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 발주 완료 팝업 */}
      {orderCompleteResult && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
            zIndex: 50,
          }}
        >
          <div
            style={{
              backgroundColor: "#ffffff",
              borderRadius: "16px",
              padding: "28px 24px",
              maxWidth: "420px",
              width: "100%",
              textAlign: "center",
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.2)",
            }}
          >
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>🎉</div>
            <h3 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", marginBottom: "8px" }}>
              발주서가 성공적으로 접수되었습니다!
            </h3>
            <p style={{ fontSize: "13px", color: "#64748b", lineHeight: "1.6", marginBottom: "16px" }}>
              도매처({wholesaler.business_name})에 카카오 알림톡이 즉시 발송되었습니다.
            </p>

            <div style={{ backgroundColor: "#f8fafc", padding: "12px", borderRadius: "8px", fontSize: "13px", marginBottom: "20px", textAlign: "left" }}>
              <div><strong>주문 번호:</strong> {orderCompleteResult.orderNumber}</div>
              {orderCompleteResult.notificationId && (
                <div style={{ color: "#166534", marginTop: "4px" }}>
                  <strong>알림톡 발송 ID:</strong> {orderCompleteResult.notificationId}
                </div>
              )}
            </div>

            <button
              onClick={() => {
                setOrderCompleteResult(null);
                setIsCheckoutOpen(false);
              }}
              style={{
                width: "100%",
                backgroundColor: "#0f172a",
                color: "#ffffff",
                padding: "12px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 700,
                border: "none",
                cursor: "pointer",
              }}
            >
              확인
            </button>
          </div>
        </div>
      )}

      {/* 푸터 법적 고지 (PRD Section 5 준수) */}
      <footer style={{ padding: "24px 16px", textAlign: "center", borderTop: "1px solid #e2e8f0", backgroundColor: "#ffffff", marginTop: "40px" }}>
        <p style={{ fontSize: "11px", color: "#94a3b8", lineHeight: "1.5" }}>
          본 상점은 <strong>{wholesaler.business_name}</strong>과 계약된 구매 회원(바이어)을 위한 비공개 1:1 발주 공간입니다.
          <br />
          타 도매업자에게 정보가 일체 공유되지 않습니다.
        </p>
      </footer>
    </div>
  );
}

