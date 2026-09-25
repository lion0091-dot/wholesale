"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Product } from "@/types/database";
import { createProductAction, updateProductAction } from "./actions";
import { isTraceableCategory, TRACEABLE_MANUAL_BLOCK_MESSAGE } from "@/lib/products/traceable-categories";
import { MarketPriceWidget } from "@/components/market-price-widget";
import { ProductStockBreakdownWidget } from "@/components/product-stock-breakdown";
import { composeIdentityName, identityFieldsFor } from "@/lib/products/identity-key";

interface ProductFormViewProps {
  /** 수정 모드일 때 기존 상품 값 */
  product?: Product;
  /** 플랫폼 공용 카테고리 목록(product_categories 테이블) — 슈퍼관리자가 관리 */
  categories: string[];
  /** 축종별 부위 목록(product_subcategories 테이블). 카테고리 선택에 따라 캐스케이딩된다. */
  subcategoriesByCategory: Record<string, string[]>;
}

const FALLBACK_CATEGORIES = ["소", "돼지", "닭/오리", "양", "가공육"];
const UNITS = ["kg", "박스", "마리", "팩"];
const FORM_ID = "product-form";
const QUICK_ADD_AMOUNTS = [1000, 5000, 10000, 50000];

/** 1000 -> "+1천", 50000 -> "+5만" 같은 짧은 라벨. */
function formatQuickAddLabel(amount: number): string {
  if (amount % 10000 === 0) return `+${amount / 10000}만`;
  if (amount % 1000 === 0) return `+${amount / 1000}천`;
  return `+${amount.toLocaleString("ko-KR")}`;
}

/** 숫자만 남긴 문자열에 천 단위 콤마를 붙인다 ("25000" -> "25,000"). */
function formatThousands(digitsOnly: string): string {
  if (!digitsOnly) return "";
  return Number(digitsOnly).toLocaleString("ko-KR");
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
  // 좁은 화면에서 한글이 어절 중간에서 잘려 줄바꿈되면 오타처럼 보인다(예: "전달용" -> "전달\n용").
  wordBreak: "keep-all",
};

/** 등록 후 잠기는 정체성 필드(상품명/원산지)에 쓰는 읽기 전용 스타일 — 축종의 disabled 상태와 시각적으로 맞춘다. */
const readOnlyFieldStyle: CSSProperties = {
  ...fieldStyle,
  backgroundColor: "#f1f5f9",
  color: "#64748b",
  cursor: "not-allowed",
};

/** 체크박스 대신 쓰는 토글 스위치 — 행 전체가 터치 영역, 옵션명 옆 "?"로 짧은 설명을 띄운다. */
function ToggleField({
  label,
  checked,
  onChange,
  accentColor = "#0f172a",
  help,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  accentColor?: string;
  help?: string;
}) {
  const [showHelp, setShowHelp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!showHelp) return;

    function handleOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowHelp(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [showHelp]);

  return (
    <div ref={containerRef}>
      <div
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onClick={(event) => {
          // "?" 버튼 클릭이 전파돼 올라온 경우 토글이 같이 바뀌는 문제가 있어,
          // 클릭 대상이 도움말 버튼이면 무조건 무시한다.
          if (helpButtonRef.current && helpButtonRef.current.contains(event.target as Node)) {
            return;
          }
          onChange(!checked);
        }}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            onChange(!checked);
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "12px 14px",
          borderRadius: "10px",
          border: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
          cursor: "pointer",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "14px", fontWeight: 600, color: accentColor }}>
          {label}
          {help && (
            <button
              ref={helpButtonRef}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setShowHelp((prev) => !prev);
              }}
              aria-label={`${label} 설명 보기`}
              style={{
                width: "18px",
                height: "18px",
                borderRadius: "999px",
                border: "1px solid #cbd5e1",
                backgroundColor: "#f1f5f9",
                color: "#64748b",
                fontSize: "11px",
                fontWeight: 700,
                lineHeight: "16px",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              ?
            </button>
          )}
        </span>

        <span
          aria-hidden
          style={{
            width: "42px",
            height: "24px",
            borderRadius: "999px",
            backgroundColor: checked ? "#dc2626" : "#cbd5e1",
            position: "relative",
            flexShrink: 0,
            transition: "background-color 0.15s ease",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: "2px",
              left: checked ? "20px" : "2px",
              width: "20px",
              height: "20px",
              borderRadius: "50%",
              backgroundColor: "#ffffff",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
              transition: "left 0.15s ease",
            }}
          />
        </span>
      </div>

      {help && showHelp && (
        <div
          role="tooltip"
          style={{
            marginTop: "6px",
            backgroundColor: "#0f172a",
            color: "#f8fafc",
            fontSize: "12px",
            lineHeight: 1.5,
            padding: "8px 10px",
            borderRadius: "8px",
          }}
        >
          {help}
        </div>
      )}
    </div>
  );
}

interface FieldOption {
  value: string;
  label: string;
}

/**
 * PC는 기존 네이티브 select 그대로, 모바일(<=900px)은 화면 하단에서 올라오는
 * 바텀시트로 대체한다 — 엄지로 스크롤/탭하기 쉬운 위치에서 옵션을 고르게 하기 위함.
 * 실제 폼 제출값은 항상 hidden input 하나로만 나간다(두 UI 모두 같은 name을 쓰면
 * FormData에 중복 값이 실려서 헷갈리므로, select/버튼 자체엔 name을 붙이지 않는다).
 */
function BottomSheetField({
  id,
  name,
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  options: FieldOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? "";

  return (
    <>
      <input type="hidden" name={name} value={value} />

      <select
        id={id}
        className="dash-desktop-only"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        style={fieldStyle}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="dash-mobile-only"
        disabled={disabled}
        aria-label={label}
        onClick={() => setOpen(true)}
        style={{
          ...fieldStyle,
          justifyContent: "space-between",
          alignItems: "center",
          textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span>{selectedLabel}</span>
        <span aria-hidden style={{ color: "#94a3b8" }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            backgroundColor: "rgba(15, 23, 42, 0.5)",
            display: "flex",
            alignItems: "flex-end",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              backgroundColor: "#ffffff",
              borderTopLeftRadius: "16px",
              borderTopRightRadius: "16px",
              width: "100%",
              maxHeight: "70vh",
              display: "flex",
              flexDirection: "column",
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
              animation: "dash-sheet-up 0.2s ease-out",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
              <span
                style={{
                  width: "36px",
                  height: "4px",
                  borderRadius: "999px",
                  backgroundColor: "#e2e8f0",
                }}
              />
            </div>
            <div
              style={{
                padding: "4px 16px 12px",
                fontSize: "14px",
                fontWeight: 700,
                color: "#0f172a",
                borderBottom: "1px solid #f1f5f9",
              }}
            >
              {label}
            </div>
            <div style={{ overflowY: "auto", padding: "4px 0" }}>
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    width: "100%",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "14px 16px",
                    fontSize: "15px",
                    fontWeight: option.value === value ? 700 : 500,
                    color: option.value === value ? "#dc2626" : "#0f172a",
                    backgroundColor: "transparent",
                    border: "none",
                    textAlign: "left",
                  }}
                >
                  {option.label}
                  {option.value === value && <span aria-hidden>✓</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function ProductFormView({
  product,
  categories,
  subcategoriesByCategory,
}: ProductFormViewProps) {
  const router = useRouter();
  const isEdit = Boolean(product);
  // 신규 등록에서는 이력 대상 축종(소·돼지·닭/오리)을 고를 수 없다 — 그 상품은 입고 스캔으로 만들어진다.
  // 수정 화면은 이미 있는 상품이라 그대로 둔다.
  const allCategoryOptions = categories.length > 0 ? categories : FALLBACK_CATEGORIES;
  const categoryOptions = isEdit ? allCategoryOptions : allCategoryOptions.filter((item) => !isTraceableCategory(item));

  const [selectedCategory, setSelectedCategory] = useState(product?.category ?? categoryOptions[0]);
  const subcategoryOptions = subcategoriesByCategory[selectedCategory] ?? [];
  const [selectedSubcategory, setSelectedSubcategory] = useState(() => {
    const initialOptions = subcategoriesByCategory[product?.category ?? categoryOptions[0]] ?? [];
    return initialOptions.includes(product?.subcategory ?? "") ? product?.subcategory ?? "" : "";
  });
  const [unit, setUnit] = useState(product?.unit ?? UNITS[0]);
  const [gradeValue, setGradeValue] = useState(product?.grade ?? "");

  // 소처럼 정체성 키가 정해진 축종은 상품명을 적지 않는다 — 부위+등급으로 자동 조합된다(lib/products/identity-key.ts).
  // 등록 후에는 값이 이미 있는 부위·등급·원산지가 잠긴다(비어 있던 칸만 한 번 채울 수 있다).
  const hasIdentityKey = identityFieldsFor(selectedCategory) !== null;
  const partLocked = isEdit && hasIdentityKey && Boolean(product?.subcategory?.trim());
  const gradeLocked = isEdit && hasIdentityKey && Boolean(product?.grade?.trim());
  const composedName = composeIdentityName(selectedCategory, selectedSubcategory, gradeValue);
  const willRename = !isEdit || (!partLocked && Boolean(selectedSubcategory)) || (!gradeLocked && Boolean(gradeValue.trim()));
  const nameToShow = hasIdentityKey && willRename ? (composedName ?? "") : product?.name;

  const handleCategoryChange = (next: string) => {
    setSelectedCategory(next);
    setSelectedSubcategory((prev) => {
      const nextOptions = subcategoriesByCategory[next] ?? [];
      return nextOptions.includes(prev) ? prev : "";
    });
  };

  const [basePrice, setBasePrice] = useState(product ? String(product.base_price) : "");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [isActive, setIsActive] = useState(product ? product.is_active : true);
  const [hotDealActive, setHotDealActive] = useState(product?.hot_deal_active ?? false);
  const [hotDealPrice, setHotDealPrice] = useState(
    product?.hot_deal_price != null ? String(product.hot_deal_price) : ""
  );
  const [hotDealQuantityLimit, setHotDealQuantityLimit] = useState(
    product?.hot_deal_quantity_limit != null ? String(product.hot_deal_quantity_limit) : ""
  );
  const [hotDealQuotaAlertThreshold, setHotDealQuotaAlertThreshold] = useState(
    product?.hot_deal_quota_alert_threshold != null ? String(product.hot_deal_quota_alert_threshold) : ""
  );
  const initialOrderStopped = product?.order_stopped ?? false;
  const [orderStopped, setOrderStopped] = useState(initialOrderStopped);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 원매가(매입 원가)는 현재 DB 컬럼이 없어 저장되지 않는 화면 계산용 참고값이다.
  const base = Number.parseFloat(basePrice);
  const purchase = Number.parseFloat(purchasePrice);
  const marginRate =
    Number.isFinite(base) && base > 0 && Number.isFinite(purchase) && purchase >= 0
      ? ((base - purchase) / base) * 100
      : null;

  const hotDeal = Number.parseFloat(hotDealPrice);
  const hotDealDiscountRate =
    Number.isFinite(base) && base > 0 && Number.isFinite(hotDeal) && hotDeal >= 0
      ? ((base - hotDeal) / base) * 100
      : null;

  // 폼이 로드된 뒤 실제로 토글을 건드렸을 때만 서버에 의도를 전달한다("none"이면
  // 발주정지 컬럼 자체를 건드리지 않음 — 자동정지가 폼을 여는 사이 걸렸어도 보존).
  const orderStoppedAction: "none" | "stop" | "resume" =
    orderStopped === initialOrderStopped ? "none" : orderStopped ? "stop" : "resume";

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
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", paddingBottom: "88px" }}>
      <header>
        <Link href="/dashboard/products" style={{ fontSize: "12px", color: "#64748b" }}>
          ← 상품 목록으로
        </Link>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", marginTop: "6px" }}>
          {isEdit ? "상품 정보 수정" : "신규 상품 등록"}
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          {isEdit
            ? "고객(소매) 미니샵에 노출될 품목 정보와 기본 단가를 입력하세요."
            : TRACEABLE_MANUAL_BLOCK_MESSAGE}
        </p>
      </header>

      <form
        id={FORM_ID}
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
            {hasIdentityKey ? (
              <input
                id="name"
                name="name"
                type="text"
                readOnly
                value={nameToShow ?? ""}
                placeholder="부위·등급을 고르면 자동으로 채워져요"
                autoComplete="off"
                style={readOnlyFieldStyle}
              />
            ) : (
              <input
                id="name"
                name="name"
                type="text"
                required
                minLength={2}
                readOnly={isEdit}
                defaultValue={product?.name}
                placeholder="예: 등심"
                autoComplete="off"
                style={isEdit ? readOnlyFieldStyle : fieldStyle}
              />
            )}
            <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "5px" }}>
              {hasIdentityKey
                ? `${selectedCategory}는 축종·부위·등급·원산지가 이 상품의 정체성이에요. 상품명은 부위와 등급으로 자동으로 만들어지고, 축종은 화면에서 앞에 자동으로 붙어요.`
                : isEdit
                  ? "등록 후에는 상품명을 바꿀 수 없어요. 축종·상품명·원산지가 이 상품의 정체성이라 셋 중 하나라도 다르면 새 상품으로 등록해주세요."
                  : "축종은 아래에서 따로 고르면 화면에 자동으로 앞에 붙어요. 여기엔 부위/상세 설명만 적으면 됩니다."}
            </p>
          </div>

          <div>
            <label htmlFor="category" style={labelStyle}>
              축종/카테고리 *
            </label>
            <BottomSheetField
              id="category"
              name="category"
              label="축종/카테고리"
              value={selectedCategory}
              onChange={handleCategoryChange}
              disabled={isEdit}
              options={categoryOptions.map((item) => ({ value: item, label: item }))}
            />
            {isEdit && (
              <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "5px" }}>
                등록 후에는 축종을 바꿀 수 없어요. 축종이 다른 상품이면 새로 등록해주세요.
              </p>
            )}
          </div>
        </div>

        <div className="dash-form-grid-3">
          <div>
            <label htmlFor="subcategory" style={labelStyle}>
              {hasIdentityKey ? "부위 *" : "부위 (선택)"}
            </label>
            <BottomSheetField
              id="subcategory"
              name="subcategory"
              label="부위"
              value={selectedSubcategory}
              onChange={setSelectedSubcategory}
              disabled={subcategoryOptions.length === 0 || partLocked}
              options={[
                ...(hasIdentityKey && !isEdit ? [] : [{ value: "", label: "선택 안 함" }]),
                ...subcategoryOptions.map((item) => ({ value: item, label: item })),
              ]}
            />
            {partLocked && (
              <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "5px" }}>
                등록 후에는 부위를 바꿀 수 없어요. 부위가 다르면 새 상품으로 등록해주세요.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="origin" style={labelStyle}>
              원산지 *
            </label>
            <input
              id="origin"
              name="origin"
              type="text"
              required
              readOnly={isEdit}
              defaultValue={product?.origin}
              placeholder="예: 국내산, 미국산"
              autoComplete="off"
              style={isEdit ? readOnlyFieldStyle : fieldStyle}
            />
            {isEdit && (
              <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "5px" }}>
                등록 후에는 원산지를 바꿀 수 없어요.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="grade" style={labelStyle}>
              {hasIdentityKey ? "등급 *" : "등급"}
            </label>
            <input
              id="grade"
              name="grade"
              type="text"
              required={hasIdentityKey && !isEdit}
              readOnly={gradeLocked}
              value={gradeValue}
              onChange={(event) => setGradeValue(event.target.value)}
              placeholder="예: 1++, 1등급, 프라임"
              autoComplete="off"
              style={gradeLocked ? readOnlyFieldStyle : fieldStyle}
            />
            {gradeLocked && (
              <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "5px" }}>
                등록 후에는 등급을 바꿀 수 없어요. 등급이 다르면 새 상품으로 등록해주세요.
              </p>
            )}
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
              type="text"
              inputMode="numeric"
              required
              value={formatThousands(basePrice)}
              onChange={(event) => setBasePrice(event.target.value.replace(/[^0-9]/g, ""))}
              placeholder="25,000"
              style={fieldStyle}
            />
            <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
              {QUICK_ADD_AMOUNTS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() =>
                    setBasePrice((prev) => String((Number.parseInt(prev || "0", 10) || 0) + amount))
                  }
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    padding: "5px 10px",
                    borderRadius: "999px",
                    border: "1px solid #cbd5e1",
                    backgroundColor: "#f8fafc",
                    color: "#334155",
                    cursor: "pointer",
                  }}
                >
                  {formatQuickAddLabel(amount)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="unit" style={labelStyle}>
              단위 *
            </label>
            <BottomSheetField
              id="unit"
              name="unit"
              label="단위"
              value={unit}
              onChange={setUnit}
              options={UNITS.map((item) => ({ value: item, label: item }))}
            />
          </div>

          <div>
            <label htmlFor="stock_quantity" style={labelStyle}>
              {product ? "재고 수량 (여기서 수정 불가)" : "최초 재고 수량 *"}
            </label>
            <input
              id="stock_quantity"
              name="stock_quantity"
              type="number"
              min="0"
              step="0.1"
              required={!product}
              // 수정 모드에서는 읽기전용이다. 재고는 입출고 원장 합계로 파생되므로
              // 이 폼에서 덮어쓰면 다음 입고/출고 때 사라진다. 조정은 상품 목록의
              // "재고 조정"(사유가 원장에 남는 경로)에서만 한다.
              readOnly={Boolean(product)}
              defaultValue={product ? String(product.stock_quantity) : "10"}
              style={
                product
                  ? { ...fieldStyle, backgroundColor: "#f1f5f9", color: "#64748b", cursor: "not-allowed" }
                  : fieldStyle
              }
            />
            <p style={{ fontSize: "11px", color: "#94a3b8", margin: "4px 0 0" }}>
              {product
                ? "재고 변경은 상품 목록의 재고 조정(사유 기록)에서 하세요. 입고·출고는 자동 반영됩니다."
                : "등록 후에는 입고·출고로 자동 관리되며, 수동 변경은 상품 목록의 재고 조정에서 합니다."}
            </p>
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

          <MarketPriceWidget category={selectedCategory} />

          <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "8px" }}>
            * 원매가는 마진 확인용 참고값으로만 사용되며 저장/노출되지 않습니다. (DB 컬럼 추가 시 저장 예정)
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <ToggleField
            label="미니샵에 판매중으로 노출"
            checked={isActive}
            onChange={setIsActive}
          />
          {/* 토글은 폼 필드가 아니라서, 실제 제출값은 hidden input으로 싣는다. */}
          <input type="hidden" name="is_active" value={isActive ? "on" : "off"} />
          {/* 폼을 열어둔 사이 목록의 빠른 토글 등으로 다른 곳에서 먼저 저장되면 감지용 */}
          {product && <input type="hidden" name="updated_at" value={product.updated_at} />}
          {/* 폼 로드 시점 재고 스냅샷 — 핫딜을 끌 때 발주정지 자동해제 여부를 서버가 판단하는 데 쓴다.
              값이 바뀌었으면 위 updated_at 낙관적 잠금이 먼저 저장 충돌로 걸러준다. */}
          {product && (
            <input type="hidden" name="stock_quantity_snapshot" value={product.stock_quantity} />
          )}
          {/* 저장 전 hot_deal_active 값 — "핫딜을 지금 이 저장에서 껐는지"(전환 여부)를
              판단하는 데 쓴다. 이게 없으면 원래부터 핫딜을 안 쓰던 일반 상품까지
              매번 저장할 때마다 수동 발주정지가 조용히 풀려버린다. */}
          {product && (
            <input
              type="hidden"
              name="hot_deal_active_snapshot"
              value={product.hot_deal_active ? "on" : "off"}
            />
          )}
        </div>
        <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "-4px" }}>
          맞춤단가(거래처별 개별 우대가) 지정은 등록 후 맞춤단가관리 화면에서 고객별로 설정합니다.
        </p>

        <div
          style={{
            backgroundColor: "#fff7ed",
            border: "1px dashed #fdba74",
            borderRadius: "8px",
            padding: "14px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <ToggleField
            label="핫딜(재고처분 특가)로 전체 공개"
            checked={hotDealActive}
            onChange={setHotDealActive}
            accentColor="#c2410c"
            help="켜면 로그인하지 않은 손님을 포함해 이 상품을 보는 모든 고객에게 아래 할인가가 기본 단가 대신 보여요. 끄면 할인가는 남아있지만 적용되지 않아요."
          />
          {/* 토글은 폼 필드가 아니라서, 실제 제출값은 hidden input으로 싣는다. */}
          <input type="hidden" name="hot_deal_active" value={hotDealActive ? "on" : "off"} />
          {/* 토글을 꺼도 마지막 입력값은 유지해 다시 켤 때 다시 입력하지 않게 한다. */}
          <input type="hidden" name="hot_deal_price" value={hotDealPrice} />
          <input type="hidden" name="hot_deal_quantity_limit" value={hotDealQuantityLimit} />
          <input
            type="hidden"
            name="hot_deal_quota_alert_threshold"
            value={hotDealQuotaAlertThreshold}
          />

          {hotDealActive && (
            <div>
              <label htmlFor="hot_deal_price_display" style={labelStyle}>
                핫딜 할인가 (원) *
              </label>
              <input
                id="hot_deal_price_display"
                type="text"
                inputMode="numeric"
                value={formatThousands(hotDealPrice)}
                onChange={(event) => setHotDealPrice(event.target.value.replace(/[^0-9]/g, ""))}
                placeholder="20,000"
                style={{ ...fieldStyle, maxWidth: "200px" }}
              />
              {hotDealDiscountRate !== null && (
                <p style={{ fontSize: "12px", fontWeight: 700, marginTop: "6px", color: hotDealDiscountRate >= 0 ? "#c2410c" : "#b91c1c" }}>
                  기본 단가 대비 {hotDealDiscountRate.toFixed(1)}% {hotDealDiscountRate >= 0 ? "할인" : "인상"}
                </p>
              )}

              <label htmlFor="hot_deal_quantity_limit_display" style={{ ...labelStyle, marginTop: "10px" }}>
                핫딜 판매 한도 (선택)
              </label>
              <input
                id="hot_deal_quantity_limit_display"
                type="number"
                min="0"
                step="0.1"
                value={hotDealQuantityLimit}
                onChange={(event) => setHotDealQuantityLimit(event.target.value)}
                placeholder={`예: 20 (비워두면 재고 전부가 핫딜가, 단위: ${unit})`}
                style={{ ...fieldStyle, maxWidth: "260px" }}
              />
              <p style={{ fontSize: "11px", color: "#c2410c", marginTop: "4px" }}>
                이 수량만큼 팔리면 핫딜 매진 — 자동으로 기본 단가로 돌아가 일반 매장에서 계속 판매됩니다(핫딜
                설정 자체는 꺼지지 않으며, 완전히 끄려면 위 토글을 직접 꺼주세요).
                {product && Number(product.hot_deal_quantity_sold) > 0 && (
                  <> 현재까지 핫딜가로 {Number(product.hot_deal_quantity_sold).toLocaleString("ko-KR")}
                    {unit} 판매됨.</>
                )}
              </p>

              {hotDealQuantityLimit && (
                <>
                  <label htmlFor="hot_deal_quota_alert_threshold_display" style={{ ...labelStyle, marginTop: "10px" }}>
                    임박 알림 기준 — 남은 수량이 이 아래로 떨어지면 대시보드에 미리 알림 (선택)
                  </label>
                  <input
                    id="hot_deal_quota_alert_threshold_display"
                    type="number"
                    min="0"
                    step="0.1"
                    value={hotDealQuotaAlertThreshold}
                    onChange={(event) => setHotDealQuotaAlertThreshold(event.target.value)}
                    placeholder={`비워두면 한도의 20% 남았을 때 자동 알림 (단위: ${unit})`}
                    style={{ ...fieldStyle, maxWidth: "260px" }}
                  />
                </>
              )}
            </div>
          )}


          {isEdit && product && <ProductStockBreakdownWidget productId={product.id} />}
        </div>

        {isEdit && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              backgroundColor: "#fef2f2",
              border: "1px dashed #fca5a5",
              borderRadius: "8px",
              padding: "14px",
            }}
          >
            <ToggleField
              label="발주정지 (재고와 무관하게 주문만 막기)"
              checked={orderStopped}
              onChange={setOrderStopped}
              accentColor="#b91c1c"
              help="켜면 정상/핫딜 어느 쪽에서 보든 손님이 이 상품을 주문할 수 없어요. 재고가 0이 되면 자동으로도 켜지고, 재입고돼도 자동으로는 안 풀려요 — 다시 팔려면 여기서 직접 꺼야 합니다. 정지 사유·시각은 변경이력에서 확인하세요."
            />
            <input type="hidden" name="order_stopped_action" value={orderStoppedAction} />
          </div>
        )}

        <div>
          <label htmlFor="description" style={labelStyle}>
            상품 설명
          </label>
          <textarea
            id="description"
            name="description"
            rows={3}
            defaultValue={product?.description ?? ""}
            placeholder="지육 스펙, 보관 방법 등 고객(소매) 전달용 메모"
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

      </form>

      <div className="dash-sticky-actions">
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
          form={FORM_ID}
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
    </div>
  );
}
