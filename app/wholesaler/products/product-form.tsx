"use client";

import { useState } from "react";
import { createProduct } from "./actions";

export function ProductForm() {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const formData = new FormData(e.currentTarget);
    const res = await createProduct(formData);

    setLoading(false);
    if (res.success) {
      setIsOpen(false);
      (e.target as HTMLFormElement).reset();
    } else {
      setMessage(res.error || "상품 등록에 실패했습니다.");
    }
  }

  return (
    <div style={{ marginBottom: "24px" }}>
      {!isOpen ? (
        <button
          onClick={() => setIsOpen(true)}
          style={{
            backgroundColor: "#dc2626",
            color: "#ffffff",
            padding: "10px 18px",
            borderRadius: "8px",
            border: "none",
            fontWeight: 600,
            cursor: "pointer",
            fontSize: "14px",
            boxShadow: "0 2px 4px rgba(220, 38, 38, 0.2)",
          }}
        >
          + 신규 상품 등록
        </button>
      ) : (
        <div
          style={{
            backgroundColor: "#ffffff",
            padding: "20px",
            borderRadius: "12px",
            border: "1px solid #e2e8f0",
            boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>신규 상품 정보 입력</h3>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "14px" }}
            >
              닫기
            </button>
          </div>

          {message && (
            <div style={{ padding: "10px", backgroundColor: "#fee2e2", color: "#b91c1c", borderRadius: "6px", marginBottom: "12px", fontSize: "13px" }}>
              {message}
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: "grid", gap: "12px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  상품명 *
                </label>
                <input
                  name="name"
                  type="text"
                  placeholder="예: 한우 1++ 등심"
                  required
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "14px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  카테고리 *
                </label>
                <select
                  name="category"
                  required
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "14px" }}
                >
                  <option value="소">소 (Beef)</option>
                  <option value="돼지">돼지 (Pork)</option>
                  <option value="닭/오리">닭/오리 (Poultry)</option>
                  <option value="양">양 (Lamb)</option>
                  <option value="가공육">가공육/기타</option>
                </select>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  원산지 *
                </label>
                <input
                  name="origin"
                  type="text"
                  placeholder="예: 국내산, 미국산"
                  required
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "14px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  등급
                </label>
                <input
                  name="grade"
                  type="text"
                  placeholder="예: 1++, 1+, 프라임"
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "14px" }}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  기본 단가 (원) *
                </label>
                <input
                  name="base_price"
                  type="number"
                  min="0"
                  step="100"
                  placeholder="25000"
                  required
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "14px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  단위 *
                </label>
                <select
                  name="unit"
                  required
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "14px" }}
                >
                  <option value="kg">kg</option>
                  <option value="박스">박스</option>
                  <option value="마리">마리</option>
                  <option value="팩">팩</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                  재고 수량 *
                </label>
                <input
                  name="stock_quantity"
                  type="number"
                  min="0"
                  step="0.1"
                  defaultValue="10"
                  required
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "14px" }}
                />
              </div>
            </div>

            <div style={{ marginTop: "4px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "14px", color: "#1e293b" }}>
                <input name="is_secret_deal" type="checkbox" />
                <span style={{ fontWeight: 600, color: "#b91c1c" }}>🔥 시크릿 딜(단골/재고소진 전용 탭) 상품으로 등록</span>
              </label>
            </div>

            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                상품 설명
              </label>
              <textarea
                name="description"
                rows={2}
                placeholder="지육 스펙, 보관 방법 등 식당 전달용 메모"
                style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "14px" }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                style={{ padding: "8px 16px", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#f8fafc", cursor: "pointer", fontSize: "14px" }}
              >
                취소
              </button>
              <button
                type="submit"
                disabled={loading}
                style={{ padding: "8px 20px", borderRadius: "6px", border: "none", background: "#dc2626", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: "14px" }}
              >
                {loading ? "등록 중..." : "등록 완료"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
