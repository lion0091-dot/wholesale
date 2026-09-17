"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Product } from "@/types/database";
import { AuditLogPanel } from "@/components/audit-log-panel";
import {
  deleteProductAction,
  toggleProductFlagAction,
  updateProductStockAction,
} from "./actions";

interface ProductTableProps {
  products: Product[];
  /** 데모(샘플) 데이터일 때는 변경 버튼을 비활성화한다. */
  readOnly?: boolean;
  /** user_id → 표시 이름. 등록자/수정자 표시용 (여러 직원이 쓰는 백오피스) */
  memberNames?: Record<string, string>;
}

function stockBadge(quantity: number, unit: string) {
  if (quantity <= 0) {
    return { label: "품절", bg: "#fee2e2", color: "#991b1b", text: `0 ${unit}` };
  }

  if (quantity <= 3) {
    return { label: "부족", bg: "#ffedd5", color: "#c2410c", text: `${quantity} ${unit}` };
  }

  return { label: "정상", bg: "#dcfce7", color: "#166534", text: `${quantity} ${unit}` };
}

const chipButtonStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  padding: "5px 9px",
  borderRadius: "6px",
  border: "1px solid #cbd5e1",
  backgroundColor: "#ffffff",
  color: "#334155",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function ProductTable({ products, readOnly = false, memberNames = {} }: ProductTableProps) {
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingStockId, setEditingStockId] = useState<string | null>(null);
  const [stockInput, setStockInput] = useState("");

  const categories = useMemo(
    () => Array.from(new Set(products.map((product) => product.category))),
    [products]
  );

  const visibleProducts = products.filter((product) => {
    const matchesKeyword = keyword
      ? product.name.toLowerCase().includes(keyword.trim().toLowerCase())
      : true;
    const matchesCategory = category === "all" ? true : product.category === category;

    return matchesKeyword && matchesCategory;
  });

  const run = async (productId: string, task: () => Promise<{ success: boolean; error?: string }>) => {
    if (readOnly) {
      setError("샘플 데이터는 변경할 수 없습니다. 로그인 후 실제 상품을 등록해주세요.");
      return;
    }

    setBusyId(productId);
    setError(null);

    const result = await task();

    setBusyId(null);

    if (!result.success) {
      setError(result.error ?? "처리에 실패했습니다.");
      return;
    }

    router.refresh();
  };

  const handleSaveStock = (product: Product) => {
    const nextStock = Number.parseFloat(stockInput);

    if (!Number.isFinite(nextStock) || nextStock < 0) {
      setError("재고 수량은 0 이상의 숫자여야 합니다.");
      return;
    }

    void run(product.id, async () => {
      const result = await updateProductStockAction(product.id, nextStock);

      if (result.success) {
        setEditingStockId(null);
      }

      return result;
    });
  };

  const handleDelete = (product: Product) => {
    if (!window.confirm(`'${product.name}' 상품을 삭제하시겠습니까?`)) {
      return;
    }

    void run(product.id, () => deleteProductAction(product.id));
  };

  return (
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
          gap: "8px",
          padding: "12px",
          borderBottom: "1px solid #e2e8f0",
          flexWrap: "wrap",
        }}
      >
        <input
          type="search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="상품명 검색"
          style={{
            flex: "1 1 180px",
            minWidth: 0,
            padding: "8px 10px",
            fontSize: "13px",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
          }}
        />
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          style={{
            padding: "8px 10px",
            fontSize: "13px",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
          }}
        >
          <option value="all">전체 카테고리</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            backgroundColor: "#fee2e2",
            color: "#991b1b",
            fontSize: "13px",
            padding: "10px 12px",
            borderBottom: "1px solid #fecaca",
          }}
        >
          {error}
        </div>
      )}

      {visibleProducts.length === 0 ? (
        <p style={{ padding: "32px 16px", textAlign: "center", fontSize: "13px", color: "#94a3b8" }}>
          조건에 맞는 상품이 없습니다.
        </p>
      ) : (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>상품</th>
                <th>기본 단가</th>
                <th>재고 상태</th>
                <th>시크릿 딜</th>
                <th>판매 상태</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {visibleProducts.map((product) => {
                const stock = stockBadge(Number(product.stock_quantity), product.unit);
                const isBusy = busyId === product.id;

                return (
                  <tr key={product.id} style={{ opacity: product.is_active ? 1 : 0.55 }}>
                    <td>
                      <div style={{ fontWeight: 700 }}>{product.name}</div>
                      <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                        {product.category}
                        {product.subcategory ? ` · ${product.subcategory}` : ""} · {product.origin}
                        {product.grade ? ` · ${product.grade}` : ""}
                      </div>
                      {(product.created_by || product.updated_by) && (
                        <div style={{ fontSize: "10px", color: "#94a3b8", marginTop: "2px" }}>
                          등록: {(product.created_by && memberNames[product.created_by]) || "-"}
                          {product.updated_by && product.updated_by !== product.created_by && (
                            <> · 최근 수정: {memberNames[product.updated_by] || "-"}</>
                          )}
                        </div>
                      )}
                      <div style={{ marginTop: "4px" }}>
                        <AuditLogPanel tableName="products" rowId={product.id} />
                      </div>
                    </td>

                    <td style={{ whiteSpace: "nowrap", fontWeight: 700 }}>
                      {Number(product.base_price).toLocaleString("ko-KR")}원
                      <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 400 }}>
                        {" "}
                        / {product.unit}
                      </span>
                    </td>

                    <td>
                      {editingStockId === product.id ? (
                        <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={stockInput}
                            onChange={(event) => setStockInput(event.target.value)}
                            style={{
                              width: "78px",
                              padding: "4px 6px",
                              fontSize: "12px",
                              border: "1px solid #94a3b8",
                              borderRadius: "4px",
                            }}
                          />
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleSaveStock(product)}
                            style={{ ...chipButtonStyle, backgroundColor: "#0f172a", color: "#fff" }}
                          >
                            저장
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingStockId(null)}
                            style={{ ...chipButtonStyle, border: "none", background: "none" }}
                          >
                            취소
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              backgroundColor: stock.bg,
                              color: stock.color,
                              borderRadius: "4px",
                              padding: "3px 7px",
                            }}
                          >
                            {stock.label}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingStockId(product.id);
                              setStockInput(String(product.stock_quantity));
                            }}
                            style={{ ...chipButtonStyle, border: "none", background: "none", padding: 0 }}
                            title="클릭하여 재고 수정"
                          >
                            {stock.text} ✏️
                          </button>
                        </div>
                      )}
                    </td>

                    <td>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void run(product.id, () =>
                            toggleProductFlagAction(
                              product.id,
                              "is_secret_deal",
                              !product.is_secret_deal
                            )
                          )
                        }
                        style={{
                          ...chipButtonStyle,
                          backgroundColor: product.is_secret_deal ? "#fee2e2" : "#ffffff",
                          color: product.is_secret_deal ? "#b91c1c" : "#334155",
                          borderColor: product.is_secret_deal ? "#fca5a5" : "#cbd5e1",
                        }}
                      >
                        {product.is_secret_deal ? "🔥 시크릿 ON" : "시크릿 OFF"}
                      </button>
                    </td>

                    <td>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void run(product.id, () =>
                            toggleProductFlagAction(product.id, "is_active", !product.is_active)
                          )
                        }
                        style={{
                          ...chipButtonStyle,
                          backgroundColor: product.is_active ? "#dcfce7" : "#f1f5f9",
                          color: product.is_active ? "#166534" : "#64748b",
                          borderColor: product.is_active ? "#bbf7d0" : "#e2e8f0",
                        }}
                      >
                        {product.is_active ? "판매중" : "판매중지"}
                      </button>
                    </td>

                    <td>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <Link
                          href={`/dashboard/products/${product.id}/edit`}
                          style={{ ...chipButtonStyle, display: "inline-block" }}
                        >
                          수정
                        </Link>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDelete(product)}
                          style={{
                            ...chipButtonStyle,
                            borderColor: "#fecaca",
                            color: "#dc2626",
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
      )}
    </section>
  );
}
