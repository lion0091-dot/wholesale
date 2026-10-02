"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildFacetOptions,
  EMPTY_FACETS,
  FACET_LABELS,
  FACET_ORDER,
  facetCount,
  pruneSelection,
  type FacetKey,
  type FacetProduct,
  type FacetSelection,
} from "@/lib/products/facet-filter";

/** 한 그룹의 선택지가 이만큼을 넘으면 메뉴 안에 찾기 칸을 둔다. */
const SEARCH_THRESHOLD = 12;

interface Props {
  products: FacetProduct[];
  selection: FacetSelection;
  onChange: (next: FacetSelection) => void;
}

/** "필터" 버튼 — 누르면 아래로 축종·부위·원산지·등급 체크박스 메뉴가 열린다. */
export function ProductFacetMenu({ products, selection, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [partQuery, setPartQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const options = useMemo(() => buildFacetOptions(products, selection), [products, selection]);
  const active = facetCount(selection);

  useEffect(() => {
    if (!open) return;

    const onPointer = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (key: FacetKey, value: string) => {
    const has = selection[key].includes(value);
    const next: FacetSelection = { ...selection, [key]: has ? selection[key].filter((v) => v !== value) : [...selection[key], value] };

    // 축종을 바꾸면 그 축종에 없는 부위 선택이 남지 않게 정리한다.
    onChange(key === "species" ? pruneSelection(products, next) : next);
  };

  return (
    <div ref={rootRef} style={{ position: "relative", flex: "0 0 auto" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        style={{
          padding: "8px 12px",
          fontSize: "13px",
          fontWeight: 600,
          border: `1px solid ${active > 0 ? "#0f172a" : "#cbd5e1"}`,
          borderRadius: "6px",
          background: active > 0 ? "#0f172a" : "#ffffff",
          color: active > 0 ? "#ffffff" : "#334155",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        필터{active > 0 ? ` ${active}` : ""} ▾
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="상품 필터"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 30,
            width: "min(320px, calc(100vw - 32px))",
            maxHeight: "70vh",
            overflowY: "auto",
            padding: "12px",
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.15)",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          {FACET_ORDER.map((key) => {
            const list = options[key];

            if (list.length === 0) return null;

            const searchable = list.length > SEARCH_THRESHOLD;
            const needle = key === "part" ? partQuery.trim() : "";
            const shown = searchable && needle ? list.filter((option) => option.value.includes(needle)) : list;

            return (
              <fieldset key={key} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
                <legend style={{ fontSize: "12px", fontWeight: 800, color: "#64748b", padding: 0, marginBottom: "6px" }}>
                  {FACET_LABELS[key]}
                  {selection[key].length > 0 ? ` · ${selection[key].length}개 선택` : ""}
                </legend>

                {searchable && key === "part" ? (
                  <input
                    type="text"
                    value={partQuery}
                    onChange={(event) => setPartQuery(event.target.value)}
                    placeholder="부위 찾기"
                    aria-label="부위 찾기"
                    style={{ width: "100%", boxSizing: "border-box", padding: "7px 9px", fontSize: "13px", border: "1px solid #cbd5e1", borderRadius: "6px", marginBottom: "6px" }}
                  />
                ) : null}

                <div style={{ display: "flex", flexDirection: "column", maxHeight: searchable ? "180px" : undefined, overflowY: searchable ? "auto" : undefined }}>
                  {shown.map((option) => (
                    <label
                      key={option.value}
                      style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 2px", fontSize: "14px", color: option.count === 0 ? "#94a3b8" : "#0f172a", cursor: "pointer" }}
                    >
                      <input type="checkbox" checked={selection[key].includes(option.value)} onChange={() => toggle(key, option.value)} style={{ width: "18px", height: "18px" }} />
                      <span style={{ flex: 1 }}>{option.value}</span>
                      <span style={{ fontSize: "12px", color: "#94a3b8" }}>{option.count}</span>
                    </label>
                  ))}
                  {shown.length === 0 ? <span style={{ fontSize: "13px", color: "#94a3b8" }}>찾는 항목이 없습니다.</span> : null}
                </div>
              </fieldset>
            );
          })}

          <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", position: "sticky", bottom: 0, background: "#ffffff", paddingTop: "4px" }}>
            <button
              type="button"
              onClick={() => {
                onChange(EMPTY_FACETS);
                setPartQuery("");
              }}
              disabled={active === 0}
              style={{ padding: "8px 12px", fontSize: "13px", border: "1px solid #cbd5e1", borderRadius: "6px", background: "#ffffff", cursor: active === 0 ? "default" : "pointer", color: active === 0 ? "#94a3b8" : "#334155" }}
            >
              초기화
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{ padding: "8px 16px", fontSize: "13px", fontWeight: 700, border: "none", borderRadius: "6px", background: "#0f172a", color: "#ffffff", cursor: "pointer" }}
            >
              닫기
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
