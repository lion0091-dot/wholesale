"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Product } from "@/types/database";
import { createProductAction, updateProductAction } from "./actions";

interface ProductFormViewProps {
  /** 수정 모드일 때 기존 상품 값 */
  product?: Product;
  /** 데모 모드 안내 (저장 불가) */
  isDemoMode?: boolean;
}

const CATEGORIES = ["소", "돼지", "닭/오리", "양", "가공육"];
const UNITS = ["kg", "박스", "마리", "팩"];

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

export function ProductFormView({ product, isDemoMode = false }: ProductFormViewProps) {
  const router = useRouter();
  const isEdit = Boolean(product);

  const [basePrice, setBasePrice] = useState(product ? String(product.base_price) : "");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [isActive, setIsActive] = useState(product ? product.is_active : true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 원매가(매입 원가)는 현재 DB 컬럼이 없어 저장되지 않는 화면 계산용 참고값이다.
  const base = Number.parseFloat(basePrice);
  const purchase = Number.parseFloat(purchasePrice);
  const marginRate =
    Number.isFinite(base) && base > 0 && Number.isFinite(purchase) && purchase >= 0
      ? ((base - purchase) / base) * 100
      : null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const result = product
      ? await updateProductAction(product.id, formData)
      : await createProductAction(formData);

    setPending(false);

    if (!result.success) {
      setError(result.error ?? "저장에 실패했습니다.");
      return;
    }

    router.push("/dashboard/products");
    router.refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <Link href="/dashboard/products" style={{ fontSize: "12px", color: "#64748b" }}>
          ← 상품 목록으로
        </Link>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", marginTop: "6px" }}>
          {isEdit ? "상품 정보 수정" : "신규 상품 등록"}
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          바이어(구매 회원) 미니샵에 노출될 품목 정보와 기본 단가를 입력하세요.
        </p>
      </header>

      {isDemoMode && (
        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
          }}
        >
          ℹ️ 미인증(데모) 상태입니다. 입력 화면은 확인할 수 있으나 저장은 로그인 후에 가능합니다.
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "20px",
          display: "grid",
          gap: "14px",
        }}
      >
        <div className="dash-form-grid">
          <div>
            <label htmlFor="name" style={labelStyle}>
              상품명 *
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              minLength={2}
              defaultValue={product?.name}
              placeholder="예: 한우 1++ 등심"
              autoComplete="off"
              style={fieldStyle}
            />
          </div>

          <div>
            <label htmlFor="category" style={labelStyle}>
              부위/카테고리 *
            </label>
            <select
              id="category"
              name="category"
              required
              defaultValue={product?.category ?? CATEGORIES[0]}
              style={fieldStyle}
            >
              {CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="dash-form-grid">
          <div>
            <label htmlFor="origin" style={labelStyle}>
              원산지 *
            </label>
            <input
              id="origin"
              name="origin"
              type="text"
              required
              defaultValue={product?.origin}
              placeholder="예: 국내산, 미국산"
              autoComplete="off"
              style={fieldStyle}
            />
          </div>

          <div>
            <label htmlFor="grade" style={labelStyle}>
              등급
            </label>
            <input
              id="grade"
              name="grade"
              type="text"
              defaultValue={product?.grade ?? ""}
              placeholder="예: 1++, 1등급, 프라임"
              autoComplete="off"
              style={fieldStyle}
            />
          </div>
        </div>

        <div className="dash-form-grid-3">
          <div>
            <label htmlFor="base_price" style={labelStyle}>
              기본 단가 (원) *
            </label>
            <input
              id="base_price"
              name="base_price"
              type="number"
              min="0"
              step="100"
              required
              value={basePrice}
              onChange={(event) => setBasePrice(event.target.value)}
              placeholder="25000"
              style={fieldStyle}
            />
          </div>

          <div>
            <label htmlFor="unit" style={labelStyle}>
              단위 *
            </label>
            <select
              id="unit"
              name="unit"
              required
              defaultValue={product?.unit ?? UNITS[0]}
              style={fieldStyle}
            >
              {UNITS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="stock_quantity" style={labelStyle}>
              재고 수량 *
            </label>
            <input
              id="stock_quantity"
              name="stock_quantity"
              type="number"
              min="0"
              step="0.1"
              required
              defaultValue={product ? String(product.stock_quantity) : "10"}
              style={fieldStyle}
            />
          </div>
        </div>

        {/* 원매가 참고란 — 저장되지 않고 예상 마진 계산에만 사용 */}
        <div
          style={{
            backgroundColor: "#f8fafc",
            border: "1px dashed #cbd5e1",
            borderRadius: "8px",
            padding: "14px",
          }}
        >
          <label htmlFor="purchase_price_ref" style={labelStyle}>
            원매가(매입 원가) 참고란
          </label>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <input
              id="purchase_price_ref"
              type="number"
              min="0"
              step="100"
              value={purchasePrice}
              onChange={(event) => setPurchasePrice(event.target.value)}
              placeholder="예: 68000"
              style={{ ...fieldStyle, maxWidth: "200px" }}
            />
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
              예상 마진:{" "}
              {marginRate === null ? (
                <span style={{ color: "#94a3b8", fontWeight: 400 }}>기본 단가와 원매가 입력 시 계산</span>
              ) : (
                <span style={{ color: marginRate >= 0 ? "#166534" : "#b91c1c" }}>
                  {marginRate.toFixed(1)}% ({Math.round(base - purchase).toLocaleString("ko-KR")}원)
                </span>
              )}
            </span>
          </div>
          <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "8px" }}>
            * 원매가는 마진 확인용 참고값으로만 사용되며 저장/노출되지 않습니다. (DB 컬럼 추가 시 저장 예정)
          </p>
        </div>

        <div style={{ display: "flex", gap: "18px", flexWrap: "wrap" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            <input
              name="is_secret_deal"
              type="checkbox"
              defaultChecked={product?.is_secret_deal ?? false}
            />
            <span style={{ fontWeight: 600, color: "#b91c1c" }}>
              🔥 시크릿 딜(단골 전용 마감 특가) 상품
            </span>
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
            />
            <span style={{ fontWeight: 600, color: "#334155" }}>미니샵에 판매중으로 노출</span>
          </label>
          {/* 체크박스 미선택 시에도 값을 전달해야 하므로 hidden으로 상태를 싣는다. */}
          <input type="hidden" name="is_active" value={isActive ? "on" : "off"} />
        </div>

        <div>
          <label htmlFor="description" style={labelStyle}>
            상품 설명
          </label>
          <textarea
            id="description"
            name="description"
            rows={3}
            defaultValue={product?.description ?? ""}
            placeholder="지육 스펙, 보관 방법 등 바이어 전달용 메모"
            style={{ ...fieldStyle, resize: "vertical" }}
          />
        </div>

        {error && (
          <div
            role="alert"
            style={{
              backgroundColor: "#fee2e2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              fontSize: "13px",
              padding: "10px 12px",
              borderRadius: "8px",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <Link
            href="/dashboard/products"
            style={{
              padding: "10px 16px",
              fontSize: "14px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              backgroundColor: "#f8fafc",
              color: "#334155",
            }}
          >
            취소
          </Link>
          <button
            type="submit"
            disabled={pending}
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
            {pending ? "저장 중..." : isEdit ? "수정 저장" : "등록 완료"}
          </button>
        </div>
      </form>
    </div>
  );
}
