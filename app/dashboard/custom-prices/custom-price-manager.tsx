"use client";

import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { deleteCustomPrice, setCustomPrice } from "@/app/actions/custom_price";
import { SampleBadge } from "@/components/sample-badge";

export interface CustomerOption {
  id: string;
  name: string;
}

export interface ProductOption {
  id: string;
  name: string;
  base_price: number;
  unit: string;
  is_secret_deal: boolean;
}

export interface AssignedCustomPrice {
  id: string;
  retailerId: string;
  retailerName: string;
  productId: string;
  productName: string;
  basePrice: number;
  unit: string;
  customPrice: number;
  updatedAt: string;
}

interface CustomPriceManagerProps {
  customers: CustomerOption[];
  products: ProductOption[];
  assigned: AssignedCustomPrice[];
  /** 데모(샘플) 데이터일 때는 저장/삭제를 막는다. */
  readOnly?: boolean;
  /** 고객 관리 카드에서 바로 진입했을 때 미리 선택할 바이어 */
  initialRetailerId?: string;
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "#475569",
  marginBottom: "5px",
};

const fieldStyle: CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  fontSize: "14px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
};

const cardStyle: CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "20px",
};

function formatWon(amount: number) {
  return `${Math.round(amount).toLocaleString("ko-KR")}원`;
}

function discountRate(basePrice: number, customPrice: number) {
  if (!basePrice) return null;

  return ((basePrice - customPrice) / basePrice) * 100;
}

export function CustomPriceManager({
  customers,
  products,
  assigned,
  readOnly = false,
  initialRetailerId,
}: CustomPriceManagerProps) {
  const router = useRouter();
  const [retailerId, setRetailerId] = useState(initialRetailerId ?? customers[0]?.id ?? "");
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [price, setPrice] = useState("");
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
  // 특정 바이어로 진입했으면 지정 목록도 그 바이어로 필터링해 보여준다.
  const [filterRetailerId, setFilterRetailerId] = useState(initialRetailerId ?? "all");

  const selectedProduct = products.find((product) => product.id === productId);
  const inputPrice = Number.parseFloat(price);
  const previewRate =
    selectedProduct && Number.isFinite(inputPrice)
      ? discountRate(selectedProduct.base_price, inputPrice)
      : null;

  const existing = useMemo(
    () =>
      assigned.find((row) => row.retailerId === retailerId && row.productId === productId) ?? null,
    [assigned, retailerId, productId]
  );

  const visibleRows =
    filterRetailerId === "all"
      ? assigned
      : assigned.filter((row) => row.retailerId === filterRetailerId);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (readOnly) {
      setMessage({
        type: "error",
        text: "샘플 데이터에는 단가를 저장할 수 없습니다. 바이어 초대와 상품 등록 후 이용해주세요.",
      });
      return;
    }

    setPending(true);
    setMessage(null);

    const formData = new FormData();
    formData.set("retailer_id", retailerId);
    formData.set("product_id", productId);
    formData.set("custom_price", price);

    const result = await setCustomPrice(formData);

    setPending(false);

    if (!result.success) {
      setMessage({ type: "error", text: result.error ?? "맞춤 단가 저장에 실패했습니다." });
      return;
    }

    setPrice("");
    setMessage({ type: "success", text: "맞춤 단가를 저장했습니다." });
    router.refresh();
  };

  const handleDelete = async (row: AssignedCustomPrice) => {
    if (readOnly) {
      setMessage({ type: "error", text: "샘플 데이터는 삭제할 수 없습니다." });
      return;
    }

    if (!window.confirm(`${row.retailerName} · ${row.productName} 맞춤 단가를 삭제할까요? (기준가로 복귀)`)) {
      return;
    }

    setBusyId(row.id);
    setMessage(null);

    const result = await deleteCustomPrice(row.id);

    setBusyId(null);

    if (!result.success) {
      setMessage({ type: "error", text: result.error ?? "삭제에 실패했습니다." });
      return;
    }

    router.refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* 1) 맞춤 단가 설정 폼 */}
      <form onSubmit={handleSubmit} style={{ ...cardStyle, display: "grid", gap: "14px" }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
          바이어별 맞춤 단가 설정
        </div>

        <div className="dash-form-grid-3">
          <div>
            <label htmlFor="retailer_id" style={labelStyle}>
              고객(바이어) *
            </label>
            <select
              id="retailer_id"
              value={retailerId}
              onChange={(event) => setRetailerId(event.target.value)}
              required
              style={fieldStyle}
            >
              {customers.length === 0 && <option value="">거래 중인 바이어 없음</option>}
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="product_id" style={labelStyle}>
              상품 *
            </label>
            <select
              id="product_id"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              required
              style={fieldStyle}
            >
              {products.length === 0 && <option value="">등록된 상품 없음</option>}
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.is_secret_deal ? "🔥 " : ""}
                  {product.name} ({formatWon(product.base_price)}/{product.unit})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="custom_price" style={labelStyle}>
              맞춤 단가 (원) *
            </label>
            <input
              id="custom_price"
              type="number"
              min="0"
              step="100"
              required
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder={selectedProduct ? selectedProduct.base_price.toLocaleString("ko-KR") : "예: 25,000"}
              style={fieldStyle}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "14px",
            flexWrap: "wrap",
            fontSize: "13px",
            color: "#475569",
            backgroundColor: "#f8fafc",
            border: "1px dashed #cbd5e1",
            borderRadius: "8px",
            padding: "12px",
          }}
        >
          <span>
            기준 단가:{" "}
            <strong>
              {selectedProduct ? `${formatWon(selectedProduct.base_price)} / ${selectedProduct.unit}` : "-"}
            </strong>
          </span>
          <span>
            할인율:{" "}
            {previewRate === null ? (
              <span style={{ color: "#94a3b8" }}>단가 입력 시 계산</span>
            ) : (
              <strong style={{ color: previewRate >= 0 ? "#166534" : "#b91c1c" }}>
                {previewRate.toFixed(1)}%{previewRate < 0 ? " (기준가보다 높음)" : ""}
              </strong>
            )}
          </span>
        </div>

        {existing && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              backgroundColor: "#ffedd5",
              border: "1px solid #fdba74",
              borderRadius: "8px",
              padding: "10px 12px",
              fontSize: "13px",
              fontWeight: 700,
              color: "#9a3412",
            }}
          >
            ⚠️ 이미 지정된 단가({formatWon(existing.customPrice)})가 있습니다 — 저장하면 덮어씁니다.
          </div>
        )}

        {message && (
          <div
            role="alert"
            style={{
              backgroundColor: message.type === "error" ? "#fee2e2" : "#dcfce7",
              border: `1px solid ${message.type === "error" ? "#fecaca" : "#bbf7d0"}`,
              color: message.type === "error" ? "#991b1b" : "#166534",
              fontSize: "13px",
              padding: "10px 12px",
              borderRadius: "8px",
            }}
          >
            {message.text}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="submit"
            disabled={pending || !retailerId || !productId}
            style={{
              padding: "10px 20px",
              fontSize: "14px",
              fontWeight: 700,
              borderRadius: "8px",
              border: "none",
              backgroundColor: pending ? "#f87171" : "#dc2626",
              color: "#ffffff",
              cursor: pending ? "wait" : "pointer",
            }}
          >
            {pending ? "저장 중..." : existing ? "맞춤 단가 변경" : "맞춤 단가 저장"}
          </button>
        </div>
      </form>

      {/* 2) 지정된 맞춤 단가 목록 */}
      <section
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            padding: "12px",
            borderBottom: "1px solid #e2e8f0",
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
            지정된 맞춤 단가 ({visibleRows.length})
          </div>
          <select
            value={filterRetailerId}
            onChange={(event) => setFilterRetailerId(event.target.value)}
            style={{
              padding: "7px 10px",
              fontSize: "13px",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
            }}
          >
            <option value="all">전체 바이어</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </div>

        {visibleRows.length === 0 ? (
          <p
            style={{
              padding: "32px 16px",
              textAlign: "center",
              fontSize: "13px",
              color: "#94a3b8",
            }}
          >
            지정된 맞춤 단가가 없습니다. 위 폼에서 바이어별 VIP 단가를 설정하세요.
          </p>
        ) : (
          <>
          <div className="dash-table-wrap dash-desktop-only">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>고객(바이어)</th>
                  <th>상품</th>
                  <th>기준 단가</th>
                  <th>맞춤 단가</th>
                  <th>할인율</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const rate = discountRate(row.basePrice, row.customPrice);

                  return (
                    <tr key={row.id}>
                      <td style={{ fontWeight: 600 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          {row.retailerName}
                          {readOnly && <SampleBadge />}
                        </div>
                      </td>
                      <td>{row.productName}</td>
                      <td style={{ whiteSpace: "nowrap", color: "#64748b" }}>
                        {formatWon(row.basePrice)} / {row.unit}
                      </td>
                      <td style={{ whiteSpace: "nowrap", fontWeight: 700, color: "#b91c1c" }}>
                        {formatWon(row.customPrice)}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {rate === null ? "-" : `${rate.toFixed(1)}%`}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            type="button"
                            onClick={() => {
                              setRetailerId(row.retailerId);
                              setProductId(row.productId);
                              setPrice(String(row.customPrice));
                              setMessage(null);
                            }}
                            style={{
                              fontSize: "12px",
                              fontWeight: 600,
                              padding: "5px 9px",
                              borderRadius: "6px",
                              border: "1px solid #cbd5e1",
                              backgroundColor: "#ffffff",
                              color: "#334155",
                              cursor: "pointer",
                            }}
                          >
                            수정
                          </button>
                          <button
                            type="button"
                            disabled={busyId === row.id}
                            onClick={() => void handleDelete(row)}
                            style={{
                              fontSize: "12px",
                              fontWeight: 600,
                              padding: "5px 9px",
                              borderRadius: "6px",
                              border: "1px solid #fecaca",
                              backgroundColor: "#ffffff",
                              color: "#dc2626",
                              cursor: "pointer",
                            }}
                          >
                            삭제
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="dash-mobile-only" style={{ flexDirection: "column", gap: "10px", padding: "12px" }}>
            {visibleRows.map((row) => {
              const rate = discountRate(row.basePrice, row.customPrice);

              return (
                <div
                  key={row.id}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "10px",
                    padding: "12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <div style={{ fontWeight: 700, fontSize: "15px", color: "#0f172a" }}>
                        {row.retailerName}
                      </div>
                      {readOnly && <SampleBadge />}
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                      {row.productName}
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "12px", color: "#64748b" }}>
                      기준 {formatWon(row.basePrice)} / {row.unit}
                    </span>
                    <span style={{ fontSize: "16px", fontWeight: 700, color: "#b91c1c" }}>
                      {formatWon(row.customPrice)}
                    </span>
                  </div>

                  <div style={{ fontSize: "12px", color: "#334155" }}>
                    할인율: {rate === null ? "-" : `${rate.toFixed(1)}%`}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: "6px",
                      borderTop: "1px solid #f1f5f9",
                      paddingTop: "8px",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setRetailerId(row.retailerId);
                        setProductId(row.productId);
                        setPrice(String(row.customPrice));
                        setMessage(null);
                      }}
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        padding: "7px 11px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        backgroundColor: "#ffffff",
                        color: "#334155",
                        cursor: "pointer",
                      }}
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => void handleDelete(row)}
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        padding: "7px 11px",
                        borderRadius: "6px",
                        border: "1px solid #fecaca",
                        backgroundColor: "#ffffff",
                        color: "#dc2626",
                        cursor: "pointer",
                      }}
                    >
                      삭제
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          </>
        )}
      </section>
    </div>
  );
}
