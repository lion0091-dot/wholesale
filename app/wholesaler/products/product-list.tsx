"use client";

import { useState } from "react";
import type { Product } from "@/types/database";
import {
  toggleProductActive,
  toggleSecretDeal,
  updateProductStock,
  deleteProduct,
} from "./actions";

interface ProductListProps {
  products: Product[];
}

export function ProductList({ products }: ProductListProps) {
  const [editingStockId, setEditingStockId] = useState<string | null>(null);
  const [stockInput, setStockInput] = useState<string>("");
  const [loadingId, setLoadingId] = useState<string | null>(null);

  async function handleToggleActive(p: Product) {
    setLoadingId(p.id);
    await toggleProductActive(p.id, p.is_active);
    setLoadingId(null);
  }

  async function handleToggleSecret(p: Product) {
    setLoadingId(p.id);
    await toggleSecretDeal(p.id, p.is_secret_deal);
    setLoadingId(null);
  }

  async function handleSaveStock(productId: string) {
    const val = parseFloat(stockInput);
    if (isNaN(val) || val < 0) {
      alert("올바른 재고 수량을 입력하세요.");
      return;
    }
    setLoadingId(productId);
    await updateProductStock(productId, val);
    setEditingStockId(null);
    setLoadingId(null);
  }

  async function handleDelete(productId: string, name: string) {
    if (!confirm(`'${name}' 상품을 정말 삭제하시겠습니까?`)) return;
    setLoadingId(productId);
    await deleteProduct(productId);
    setLoadingId(null);
  }

  if (products.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px", background: "#ffffff", borderRadius: "12px", border: "1px dashed #cbd5e1" }}>
        <p style={{ color: "#64748b", fontSize: "15px" }}>등록된 육류 상품이 없습니다.</p>
        <p style={{ color: "#94a3b8", fontSize: "13px", marginTop: "4px" }}>상단의 '+ 신규 상품 등록' 버튼을 눌러 상품을 추가하세요.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "12px" }}>
      {products.map((p) => (
        <div
          key={p.id}
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            border: `1px solid ${p.is_secret_deal ? "#fca5a5" : "#e2e8f0"}`,
            padding: "16px",
            opacity: p.is_active ? 1 : 0.6,
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            position: "relative",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span
                  style={{
                    backgroundColor: p.is_secret_deal ? "#fee2e2" : "#f1f5f9",
                    color: p.is_secret_deal ? "#b91c1c" : "#475569",
                    fontSize: "11px",
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: "4px",
                  }}
                >
                  {p.category}
                </span>
                {p.is_secret_deal && (
                  <span style={{ backgroundColor: "#991b1b", color: "#fff", fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px" }}>
                    🔥 시크릿 딜
                  </span>
                )}
                <h4 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>{p.name}</h4>
              </div>
              <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
                원산지: {p.origin} {p.grade ? `| 등급: ${p.grade}` : ""}
              </p>
            </div>

            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>
                {Number(p.base_price).toLocaleString()}원
                <span style={{ fontSize: "12px", fontWeight: 400, color: "#64748b", marginLeft: "2px" }}>/ {p.unit}</span>
              </div>
            </div>
          </div>

          {p.description && (
            <p style={{ fontSize: "13px", color: "#475569", background: "#f8fafc", padding: "8px", borderRadius: "6px", marginBottom: "12px" }}>
              {p.description}
            </p>
          )}

          {/* 재고 및 액션 버튼 바 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: "12px", borderTop: "1px solid #f1f5f9" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
              <span style={{ color: "#64748b" }}>재고:</span>
              {editingStockId === p.id ? (
                <div style={{ display: "flex", gap: "4px" }}>
                  <input
                    type="number"
                    defaultValue={p.stock_quantity}
                    onChange={(e) => setStockInput(e.target.value)}
                    style={{ width: "70px", padding: "2px 6px", fontSize: "13px", border: "1px solid #94a3b8", borderRadius: "4px" }}
                  />
                  <button
                    onClick={() => handleSaveStock(p.id)}
                    style={{ padding: "2px 8px", fontSize: "12px", background: "#0f172a", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}
                  >
                    저장
                  </button>
                  <button
                    onClick={() => setEditingStockId(null)}
                    style={{ padding: "2px 6px", fontSize: "12px", background: "none", border: "none", color: "#64748b", cursor: "pointer" }}
                  >
                    취소
                  </button>
                </div>
              ) : (
                <span
                  onClick={() => {
                    setEditingStockId(p.id);
                    setStockInput(String(p.stock_quantity));
                  }}
                  style={{ fontWeight: 700, color: p.stock_quantity <= 3 ? "#dc2626" : "#0f172a", cursor: "pointer", textDecoration: "underline" }}
                  title="클릭하여 재고 변경"
                >
                  {p.stock_quantity} {p.unit} ✏️
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: "6px" }}>
              <button
                disabled={loadingId === p.id}
                onClick={() => handleToggleSecret(p)}
                style={{
                  padding: "4px 10px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: p.is_secret_deal ? "#fee2e2" : "#ffffff",
                  color: p.is_secret_deal ? "#b91c1c" : "#475569",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                {p.is_secret_deal ? "시크릿 해제" : "시크릿 설정"}
              </button>

              <button
                disabled={loadingId === p.id}
                onClick={() => handleToggleActive(p)}
                style={{
                  padding: "4px 10px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: p.is_active ? "#ffffff" : "#f1f5f9",
                  color: p.is_active ? "#0f172a" : "#94a3b8",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                {p.is_active ? "판매중" : "판매중지"}
              </button>

              <button
                disabled={loadingId === p.id}
                onClick={() => handleDelete(p.id, p.name)}
                style={{
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "1px solid #fecaca",
                  background: "#fff",
                  color: "#dc2626",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
