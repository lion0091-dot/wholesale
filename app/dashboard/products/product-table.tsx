"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Product } from "@/types/database";
import { SampleBadge } from "@/components/sample-badge";
import { MiniToggle } from "@/components/mini-toggle";
import { composeProductDisplayName } from "@/lib/products/display-name";
import { findMarketPrice, type MarketPriceIndex } from "@/lib/market-price/product-match";
import {
  deleteProductAction,
  toggleProductFlagAction,
  updateProductStockAction,
  setProductArchivedAction,
} from "./actions";
import { STOCK_ADJUST_REASONS } from "@/lib/products/stock-adjust-reasons";
import { DevSamplePanel } from "@/lib/dev-samples/DevSamplePanel";
import {
  PRODUCT_SAMPLE_KINDS,
  buildSampleProduct,
  type SampleProduct,
  type ProductSampleKey,
} from "@/lib/dev-samples/product";

/** get_product_stock_summary() 한 행 — 상품 하나를 채우고 있는 박스들의 요약 */
export interface StockSummary {
  product_id: string;
  box_count: number;
  /** 가장 오래된 박스의 도축일. 선입선출 관리에서 실제로 봐야 하는 값이다. */
  oldest_slaughter_date: string | null;
  latest_slaughter_date: string | null;
  oldest_packing_date: string | null;
  /** 이 상품에 섞여 있는 등급들 (예: "1+, 1++") */
  grades: string | null;
}

/** 도축일로부터 며칠 지났는지. 30일을 넘으면 경고색으로 표시한다. */
function freshnessInfo(dateText: string | null): { label: string; days: number; tone: string } | null {
  if (!dateText) {
    return null;
  }

  const days = Math.floor((Date.now() - new Date(dateText).getTime()) / 86_400_000);

  if (!Number.isFinite(days)) {
    return null;
  }

  return {
    label: dateText.slice(2).replace(/-/g, "."),
    days,
    tone: days >= 30 ? "#b91c1c" : days >= 14 ? "#b45309" : "#475569",
  };
}

interface ProductTableProps {
  products: Product[];
  /** user_id → 표시 이름. 등록자/수정자 표시용 (여러 직원이 쓰는 백오피스) */
  memberNames?: Record<string, string>;
  stockSummaries?: Record<string, StockSummary>;
  /** 축종+등급 → 공공 경락가. 상품 줄마다 내 판매가와 나란히 보여준다. */
  marketPrices?: MarketPriceIndex;
}

/** 오픈 직전 Vercel에서 이 값을 지우거나 false로 바꾸면 샘플 패널이 전부 사라진다. */
const SHOW_DEV_SAMPLES = process.env.NEXT_PUBLIC_SHOW_DEV_SAMPLES === "true";

function stockBadge(quantity: number, unit: string) {
  if (quantity <= 0) {
    return { label: "품절", bg: "#fee2e2", color: "#991b1b", text: `0 ${unit}` };
  }

  if (quantity <= 3) {
    return { label: "부족", bg: "#ffedd5", color: "#c2410c", text: `${quantity} ${unit}` };
  }

  return { label: "정상", bg: "#dcfce7", color: "#166534", text: `${quantity} ${unit}` };
}

/** 재고 숫자 밑에 붙는 "도축 25.09.18 · 4일 경과 · 박스 3" 한 줄 */
function StockFreshness({ summary }: { summary?: StockSummary }) {
  // 스캔으로 들어온 박스가 없으면 보여줄 도축일 자체가 없다. 빈칸으로 두면
  // "왜 안 보이지?"가 되므로 이유를 한 줄로 밝힌다.
  if (!summary || !summary.box_count) {
    return (
      <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "3px" }}>
        이력 미등록 · 입고 스캔 시 도축일·포장일이 표시됩니다
      </div>
    );
  }

  const slaughter = freshnessInfo(summary.oldest_slaughter_date);
  const packing = freshnessInfo(summary.oldest_packing_date);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", fontSize: "11px", marginTop: "3px" }}>
      {slaughter ? (
        <span style={{ color: slaughter.tone }} title="가장 오래된 재고의 도축일">
          도축 {slaughter.label} · {slaughter.days}일
        </span>
      ) : null}
      {packing ? (
        <span style={{ color: "#64748b" }} title="가장 오래된 재고의 포장처리일">
          포장 {packing.label}
        </span>
      ) : null}
      {summary.grades ? (
        <span style={{ color: "#64748b" }} title="재고에 섞여 있는 등급">
          {summary.grades}
        </span>
      ) : null}
      <span style={{ color: "#94a3b8" }}>박스 {summary.box_count}</span>
    </div>
  );
}

/**
 * 내 판매가 밑에 붙는 "공공 26,980원/kg" 한 줄. 공급사 전용이다 —
 * 고객(미니샵)에는 이 컴포넌트를 쓰지 않고, DB 권한으로도 막혀 있다.
 */
function MarketPriceHint({
  category,
  grade,
  index,
}: {
  category: string;
  grade: string | null;
  index: MarketPriceIndex;
}) {
  const matched = findMarketPrice(index, category, grade);

  if (!matched) {
    return null;
  }

  return (
    <div
      style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}
      title={`공공 경락가 (${matched.snapshotDate} 기준)`}
    >
      공공 {Math.round(matched.pricePerKg).toLocaleString("ko-KR")}원/kg
    </div>
  );
}

/** 판매가를 아직 안 정한 상품은 고객에게 안 보인다 — 공급사에게 이유를 밝힌다. */
function UnpricedBadge({ basePrice }: { basePrice: number }) {
  if (Number(basePrice) > 0) {
    return null;
  }

  return (
    <div style={{ fontSize: "11px", color: "#b45309", fontWeight: 600, marginTop: "2px" }}>
      판매가 미설정 · 고객 비노출
    </div>
  );
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

/** 대표 이미지가 아직 없어 축종별 글자 아이콘으로 상품을 시각적으로 구분한다. */
const CATEGORY_ICONS: Record<string, string> = {
  소: "🐄",
  돼지: "🐷",
  "닭/오리": "🐔",
  양: "🐑",
  가공육: "🥓",
};

function categoryIcon(category: string): string {
  return CATEGORY_ICONS[category] ?? "🍖";
}

export function ProductTable({
  products,
  memberNames = {},
  stockSummaries = {},
  marketPrices = new Map(),
}: ProductTableProps) {
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("all");
  /**
   * 상태 필터. 자동 생성된 상품은 판매가 0원·판매중지로 들어오므로, 그대로 두면
   * 진짜 파는 상품이 그 사이에 묻힌다. 기본은 보관을 제외한 전체를 보여준다.
   */
  const [status, setStatus] = useState<"all" | "selling" | "unpriced" | "archived">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingStockId, setEditingStockId] = useState<string | null>(null);
  const [stockInput, setStockInput] = useState("");
  const [stockReason, setStockReason] = useState<string>(STOCK_ADJUST_REASONS[0].code);

  // 개발용 미리보기 — 입고 화면(4가지 이력번호 유형)이 실제로 확정되면 상품
  // 목록에 어떻게 반영되는지 실제 API·DB 없이 확인한다. 새로고침하면 사라진다.
  const [sampleProducts, setSampleProducts] = useState<SampleProduct[]>([]);
  const [sampleStockSummaries, setSampleStockSummaries] = useState<Record<string, StockSummary>>({});

  const allProducts = useMemo(
    () => [...sampleProducts, ...products],
    [sampleProducts, products]
  );
  const allStockSummaries = useMemo(
    () => ({ ...stockSummaries, ...sampleStockSummaries }),
    [stockSummaries, sampleStockSummaries]
  );

  const categories = useMemo(
    () => Array.from(new Set(allProducts.map((product) => product.category))),
    [allProducts]
  );

  const visibleProducts = allProducts.filter((product) => {
    const matchesKeyword = keyword
      ? product.name.toLowerCase().includes(keyword.trim().toLowerCase())
      : true;
    const matchesCategory = category === "all" ? true : product.category === category;

    const isArchived = Boolean(product.archived_at);
    const isUnpriced = Number(product.base_price) <= 0;

    const matchesStatus =
      status === "archived"
        ? isArchived
        : status === "selling"
          ? !isArchived && product.is_active && !isUnpriced
          : status === "unpriced"
            ? !isArchived && isUnpriced
            // 'all'은 보관을 뺀 전체다 — 보관은 치운 상품이라 기본 목록에 섞이면 안 된다.
            : !isArchived;

    return matchesKeyword && matchesCategory && matchesStatus;
  });

  const unpricedCount = allProducts.filter(
    (product) => !product.archived_at && Number(product.base_price) <= 0
  ).length;

  const removeSampleProduct = (id: string) => {
    setSampleProducts((prev) => prev.filter((product) => product.id !== id));
    setSampleStockSummaries((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // 개발용 미리보기 — 데이터·빌더는 lib/dev-samples/product.ts에 모아뒀다.
  // 폐기할 때 그 폴더만 지우고 아래 몇 줄 + 패널 JSX만 지우면 된다.
  const addSampleProduct = (kind: ProductSampleKey) => {
    const { product, stockSummary } = buildSampleProduct(kind);

    setSampleProducts((prev) => [product, ...prev]);
    setSampleStockSummaries((prev) => ({ ...prev, [product.id]: stockSummary }));
  };

  const clearSampleProducts = () => {
    setSampleProducts([]);
    setSampleStockSummaries({});
  };

  const run = async (productId: string, task: () => Promise<{ success: boolean; error?: string }>) => {
    if (sampleProducts.some((product) => product.id === productId)) {
      setError("샘플 상품입니다 — 실제로 동작하지 않습니다. 목록의 '샘플 삭제'로 지워주세요.");
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

    if (!stockReason) {
      setError("조정 사유를 선택해주세요.");
      return;
    }

    void run(product.id, async () => {
      const result = await updateProductStockAction(product.id, nextStock, stockReason);

      if (result.success) {
        setEditingStockId(null);
      }

      return result;
    });
  };

  const handleArchive = (product: Product, archived: boolean) => {
    if (archived && !window.confirm(`'${product.name}'을(를) 보관하시겠습니까?\n목록과 미니샵에서 빠지고, 입출고 기록은 그대로 남습니다.`)) {
      return;
    }

    void run(product.id, () => setProductArchivedAction(product.id, archived));
  };

  const handleDelete = (product: Product) => {
    if (!window.confirm(`'${composeProductDisplayName(product.category, product.name)}' 상품을 삭제하시겠습니까?`)) {
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
          flexWrap: "nowrap",
        }}
      >
        <div style={{ position: "relative", flex: "1 1 auto", minWidth: 0 }}>
          {/* type="search"의 브라우저 기본 지우기(×) 아이콘이 카카오 인앱 브라우저 등에서
              깨진 이미지(엑박)로 뜨는 문제가 있어 type="text" + 커스텀 취소 버튼을 쓴다. */}
          <input
            type="text"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="상품명 검색"
            style={{
              width: "100%",
              padding: keyword ? "8px 60px 8px 10px" : "8px 10px",
              fontSize: "13px",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
            }}
          />
          {keyword && (
            <button
              type="button"
              onClick={() => setKeyword("")}
              style={{
                position: "absolute",
                right: "6px",
                top: "50%",
                transform: "translateY(-50%)",
                fontSize: "12px",
                fontWeight: 600,
                padding: "4px 9px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                backgroundColor: "#ffffff",
                color: "#334155",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              취소
            </button>
          )}
        </div>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          style={{
            flex: "0 1 110px",
            minWidth: "84px",
            padding: "8px 6px",
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

        {/* 자동 생성 상품은 판매가 0원·판매중지로 들어온다 — 그대로 두면 진짜 파는
            상품이 묻히므로 상태로 걸러 볼 수 있게 한다. */}
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          aria-label="상태 필터"
          style={{
            flex: "0 1 130px",
            minWidth: "96px",
            padding: "8px 6px",
            fontSize: "13px",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
          }}
        >
          <option value="all">전체 (보관 제외)</option>
          <option value="selling">판매중만</option>
          <option value="unpriced">판매가 미설정{unpricedCount > 0 ? ` (${unpricedCount})` : ""}</option>
          <option value="archived">보관함</option>
        </select>
      </div>

      {SHOW_DEV_SAMPLES && (
        <DevSamplePanel
          kinds={PRODUCT_SAMPLE_KINDS}
          onAdd={addSampleProduct}
          onClearAll={clearSampleProducts}
          hasSamples={sampleProducts.length > 0}
          description="입고 4가지 유형이 확정되면 어떻게 보이는지 미리보기 — 실제 API·DB는 안 건드립니다."
          buttonStyle={chipButtonStyle}
          containerStyle={{ borderBottom: "1px solid #e2e8f0" }}
        />
      )}

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
        <>
        <div className="dash-table-wrap dash-desktop-only">
          <table className="dash-table">
            <thead>
              <tr>
                <th>상품</th>
                <th>기본 단가</th>
                <th>재고 상태</th>
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
                      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                        <span
                          aria-hidden
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "34px",
                            height: "34px",
                            fontSize: "18px",
                            borderRadius: "8px",
                            backgroundColor: "#f1f5f9",
                            flexShrink: 0,
                          }}
                        >
                          {categoryIcon(product.category)}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <div style={{ fontWeight: 700 }}>{product.name}</div>
                            {product.archived_at && (
                              <span
                                style={{
                                  fontSize: "10px",
                                  fontWeight: 700,
                                  backgroundColor: "#f1f5f9",
                                  color: "#64748b",
                                  borderRadius: "4px",
                                  padding: "2px 6px",
                                }}
                              >
                                보관됨
                              </span>
                            )}
                            {Boolean((product as SampleProduct).isSample) && <SampleBadge />}
                          </div>
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
                        </div>
                      </div>
                    </td>

                    <td style={{ whiteSpace: "nowrap", fontWeight: 700 }}>
                      {Number(product.base_price).toLocaleString("ko-KR")}원
                      <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 400 }}>
                        {" "}
                        / {product.unit}
                      </span>
                      <MarketPriceHint
                        category={product.category}
                        grade={product.grade}
                        index={marketPrices}
                      />
                      <UnpricedBadge basePrice={product.base_price} />
                    </td>

                    <td>
                      {editingStockId === product.id ? (
                        <div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
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
                          {/* 조정 사유는 원장에 그대로 남는다 — 나중에 왜 줄었는지 추적하기 위해서다. */}
                          <select
                            value={stockReason}
                            onChange={(event) => setStockReason(event.target.value)}
                            aria-label="재고 조정 사유"
                            style={{
                              padding: "4px 6px",
                              fontSize: "12px",
                              border: "1px solid #94a3b8",
                              borderRadius: "4px",
                              backgroundColor: "#fff",
                            }}
                          >
                            {STOCK_ADJUST_REASONS.map((reason) => (
                              <option key={reason.code} value={reason.code}>
                                {reason.label}
                              </option>
                            ))}
                          </select>
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
                        <div>
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
                              setStockReason(STOCK_ADJUST_REASONS[0].code);
                            }}
                            style={{
                              ...chipButtonStyle,
                              border: "1px solid #e2e8f0",
                              backgroundColor: "#f8fafc",
                              padding: "6px 10px",
                            }}
                            title="클릭하여 재고 조정"
                          >
                            {stock.text} ✏️
                          </button>
                        </div>
                        <StockFreshness summary={allStockSummaries[product.id]} />
                        </div>
                      )}
                    </td>

                    <td>
                      <MiniToggle
                        checked={product.is_active}
                        onLabel="판매중"
                        offLabel="판매중지"
                        onColor="#16a34a"
                        onTextColor="#166534"
                        disabled={isBusy}
                        onClick={() =>
                          void run(product.id, () =>
                            toggleProductFlagAction(product.id, "is_active", !product.is_active)
                          )
                        }
                      />
                    </td>

                    <td>
                      <div style={{ display: "flex", gap: "6px" }}>
                        {(product as SampleProduct).isSample ? (
                          <button
                            type="button"
                            onClick={() => removeSampleProduct(product.id)}
                            style={{ ...chipButtonStyle, borderColor: "#fecaca", color: "#dc2626" }}
                          >
                            샘플 삭제
                          </button>
                        ) : (
                          <>
                        <Link
                          href={`/dashboard/products/${product.id}/edit`}
                          style={{ ...chipButtonStyle, display: "inline-block" }}
                        >
                          수정
                        </Link>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleArchive(product, !product.archived_at)}
                          style={chipButtonStyle}
                          title={
                            product.archived_at
                              ? "다시 목록으로 꺼냅니다"
                              : "목록과 미니샵에서 감춥니다 (입출고 기록은 남습니다)"
                          }
                        >
                          {product.archived_at ? "복원" : "보관"}
                        </button>
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
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="dash-mobile-only" style={{ flexDirection: "column", gap: "10px", padding: "12px" }}>
          {visibleProducts.map((product) => {
            const stock = stockBadge(Number(product.stock_quantity), product.unit);
            const isBusy = busyId === product.id;

            return (
              <div
                key={product.id}
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "12px",
                  opacity: product.is_active ? 1 : 0.55,
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                  <span
                    aria-hidden
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "38px",
                      height: "38px",
                      fontSize: "20px",
                      borderRadius: "8px",
                      backgroundColor: "#f1f5f9",
                      flexShrink: 0,
                    }}
                  >
                    {categoryIcon(product.category)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <div style={{ fontWeight: 700, fontSize: "15px", color: "#0f172a" }}>
                        {product.name}
                      </div>
                      {Boolean((product as SampleProduct).isSample) && <SampleBadge />}
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                      {product.category}
                      {product.subcategory ? ` · ${product.subcategory}` : ""} · {product.origin}
                      {product.grade ? ` · ${product.grade}` : ""}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
                    {Number(product.base_price).toLocaleString("ko-KR")}원
                    <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 400 }}>
                      {" "}
                      / {product.unit}
                    </span>
                    <MarketPriceHint
                      category={product.category}
                      grade={product.grade}
                      index={marketPrices}
                    />
                    <UnpricedBadge basePrice={product.base_price} />
                  </span>

                  {editingStockId === product.id ? (
                    <div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={stockInput}
                        onChange={(event) => setStockInput(event.target.value)}
                        style={{
                          width: "70px",
                          padding: "6px",
                          fontSize: "12px",
                          border: "1px solid #94a3b8",
                          borderRadius: "4px",
                        }}
                      />
                      <select
                        value={stockReason}
                        onChange={(event) => setStockReason(event.target.value)}
                        aria-label="재고 조정 사유"
                        style={{
                          padding: "6px",
                          fontSize: "12px",
                          border: "1px solid #94a3b8",
                          borderRadius: "4px",
                          backgroundColor: "#fff",
                        }}
                      >
                        {STOCK_ADJUST_REASONS.map((reason) => (
                          <option key={reason.code} value={reason.code}>
                            {reason.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleSaveStock(product)}
                        style={{ ...chipButtonStyle, backgroundColor: "#0f172a", color: "#fff", padding: "7px 10px" }}
                      >
                        저장
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingStockId(null)}
                        style={{ ...chipButtonStyle, border: "none", background: "none", padding: "7px 4px" }}
                      >
                        취소
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingStockId(product.id);
                        setStockInput(String(product.stock_quantity));
                        setStockReason(STOCK_ADJUST_REASONS[0].code);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        border: "1px solid #e2e8f0",
                        backgroundColor: "#f8fafc",
                        borderRadius: "6px",
                        padding: "7px 11px",
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "#334155",
                      }}
                    >
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
                      {stock.text} ✏️
                    </button>
                  )}
                </div>

                <StockFreshness summary={allStockSummaries[product.id]} />

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-start",
                    alignItems: "center",
                    borderTop: "1px solid #f1f5f9",
                    paddingTop: "8px",
                  }}
                >
                  <MiniToggle
                    checked={product.is_active}
                    onLabel="판매중"
                    offLabel="판매중지"
                    onColor="#16a34a"
                    onTextColor="#166534"
                    disabled={isBusy}
                    onClick={() =>
                      void run(product.id, () =>
                        toggleProductFlagAction(product.id, "is_active", !product.is_active)
                      )
                    }
                  />
                </div>

                {(product.created_by || product.updated_by) && (
                  <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                    등록: {(product.created_by && memberNames[product.created_by]) || "-"}
                    {product.updated_by && product.updated_by !== product.created_by && (
                      <> · 최근 수정: {memberNames[product.updated_by] || "-"}</>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
                  {(product as SampleProduct).isSample ? (
                    <button
                      type="button"
                      onClick={() => removeSampleProduct(product.id)}
                      style={{ ...chipButtonStyle, borderColor: "#fecaca", color: "#dc2626", padding: "7px 11px" }}
                    >
                      샘플 삭제
                    </button>
                  ) : (
                    <>
                  <Link
                    href={`/dashboard/products/${product.id}/edit`}
                    style={{ ...chipButtonStyle, display: "inline-block", padding: "7px 11px" }}
                  >
                    수정
                  </Link>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleArchive(product, !product.archived_at)}
                    style={{ ...chipButtonStyle, padding: "7px 11px" }}
                  >
                    {product.archived_at ? "복원" : "보관"}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleDelete(product)}
                    style={{
                      ...chipButtonStyle,
                      borderColor: "#fecaca",
                      color: "#dc2626",
                      padding: "7px 11px",
                    }}
                  >
                    삭제
                  </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
    </section>
  );
}
