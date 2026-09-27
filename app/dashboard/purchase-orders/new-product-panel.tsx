"use client";

import { useState } from "react";
import { identityFieldsFor } from "@/lib/products/identity-key";
import { CATTLE_BREEDS, CATTLE_GRADES, ORIGIN_OPTIONS, specListRuleFor } from "@/lib/purchase-orders/spec-options";
import type { LineSpec, ProductOption } from "@/lib/purchase-orders/product-match";
import { createPurchaseOrderProductAction } from "./actions";

interface Props {
  categories: string[];
  subcategoriesByCategory: Record<string, string[]>;
  initial: LineSpec;
  onCreated: (product: ProductOption, created: boolean) => void;
  /** 없으면 취소 버튼을 보이지 않는다(등록된 품목이 없어 이 칸이 항상 열려 있을 때). */
  onCancel?: () => void;
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  fontSize: "13px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  boxSizing: "border-box",
  backgroundColor: "#fff",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: "13px",
  fontWeight: 700,
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  backgroundColor: "#fff",
  color: "#334155",
  cursor: "pointer",
};

/** 목록에 없는 품목을 칸별로 골라 상품 관리에 등록한다(판매중지·0원). 이미 있는 상품이면 새로 만들지 않고 그걸 쓴다. */
export function NewProductPanel({ categories, subcategoriesByCategory, initial, onCreated, onCancel }: Props) {
  const [category, setCategory] = useState(initial.category);
  const [breed, setBreed] = useState(initial.breed);
  const [subcategory, setSubcategory] = useState(initial.subcategory);
  const [grade, setGrade] = useState(initial.grade);
  const [origin, setOrigin] = useState(initial.origin || "국내산");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rule = specListRuleFor(category);
  const parts = subcategoriesByCategory[category] ?? [];
  const hasKey = identityFieldsFor(category) !== null;

  const changeCategory = (next: string) => {
    const nextParts = subcategoriesByCategory[next] ?? [];
    const nextRule = specListRuleFor(next);

    setCategory(next);
    setBreed((prev) => (nextRule.breedFromList && CATTLE_BREEDS.includes(prev) ? prev : ""));
    setSubcategory((prev) => (nextParts.includes(prev) ? prev : ""));
    setGrade((prev) => (nextRule.gradeFromList && !CATTLE_GRADES.includes(prev) ? "" : prev));
    setOrigin((prev) => (nextRule.originFromList && !ORIGIN_OPTIONS.includes(prev) ? "국내산" : prev));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);

    const result = await createPurchaseOrderProductAction({ category, breed, subcategory, grade, origin, name });

    setBusy(false);

    if (!result.success || !result.data) {
      setError(result.error ?? "등록하지 못했습니다.");
      return;
    }

    onCreated(result.data.product, result.data.created);
  };

  return (
    <div
      style={{
        marginTop: "8px",
        border: "1px dashed #93c5fd",
        borderRadius: "8px",
        padding: "10px",
        backgroundColor: "#f8fbff",
        display: "grid",
        gap: "8px",
      }}
    >
      <div style={{ fontSize: "12px", fontWeight: 800, color: "#1d4ed8" }}>축종부터 차례로 골라주세요 — 이미 등록된 상품이면 그걸 쓰고, 없으면 판매중지·0원으로 새로 등록합니다</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "6px" }}>
        <select aria-label="새 품목 축종" value={category} onChange={(event) => changeCategory(event.target.value)} style={fieldStyle}>
          <option value="">축종 선택</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        {rule.breedFromList && (
          <select aria-label="새 품목 품종" value={breed} onChange={(event) => setBreed(event.target.value)} style={fieldStyle}>
            <option value="">품종 선택</option>
            {CATTLE_BREEDS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        )}
        {rule.partFromList && parts.length > 0 ? (
          <select aria-label="새 품목 부위" value={subcategory} onChange={(event) => setSubcategory(event.target.value)} style={fieldStyle}>
            <option value="">부위 선택</option>
            {parts.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              aria-label="새 품목 부위"
              list="po-new-parts"
              value={subcategory}
              onChange={(event) => setSubcategory(event.target.value)}
              placeholder="부위 (선택)"
              style={fieldStyle}
              autoComplete="off"
            />
            <datalist id="po-new-parts">
              {parts.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </>
        )}
        {rule.gradeFromList ? (
          <select aria-label="새 품목 등급" value={grade} onChange={(event) => setGrade(event.target.value)} style={fieldStyle}>
            <option value="">등급 선택</option>
            {CATTLE_GRADES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : (
          <input aria-label="새 품목 등급" value={grade} onChange={(event) => setGrade(event.target.value)} placeholder="등급 (선택)" style={fieldStyle} autoComplete="off" />
        )}
        {rule.originFromList ? (
          <select aria-label="새 품목 원산지" value={origin} onChange={(event) => setOrigin(event.target.value)} style={fieldStyle}>
            <option value="">원산지 선택</option>
            {ORIGIN_OPTIONS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : (
          <input aria-label="새 품목 원산지" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="원산지" style={fieldStyle} autoComplete="off" />
        )}
        {category && !hasKey && (
          <input aria-label="새 품목 상품명" value={name} onChange={(event) => setName(event.target.value)} placeholder="상품명 *" style={fieldStyle} autoComplete="off" />
        )}
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: "12px", color: "#b91c1c" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: "8px" }}>
        <button type="button" disabled={busy} onClick={() => void submit()} style={{ ...buttonStyle, border: "none", backgroundColor: "#2563eb", color: "#fff" }}>
          {busy ? "확인 중…" : "이 조합으로 선택"}
        </button>
        {onCancel && (
          <button type="button" disabled={busy} onClick={onCancel} style={buttonStyle}>
            취소
          </button>
        )}
      </div>
    </div>
  );
}
