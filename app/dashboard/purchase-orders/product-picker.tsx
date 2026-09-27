"use client";

import { useMemo, useState } from "react";
import type { ProductOption } from "@/lib/purchase-orders/product-match";

export interface LabeledProduct {
  option: ProductOption;
  label: string;
}

interface Props {
  /** 라벨을 미리 만든 목록 — 줄마다 5,000개 라벨을 다시 만들지 않게 부모가 한 번만 만들어 넘긴다. */
  labeled: LabeledProduct[];
  labelById: ReadonlyMap<string, string>;
  recentIds: string[];
  selectedId: string;
  /** 상품을 고르지 않은 줄에 적혀 있는 스펙(엑셀에서 온 줄 등) — 입력창 안내로만 보인다. */
  fallbackLabel: string;
  ariaLabel: string;
  onPick: (option: ProductOption) => void;
  onCreateNew: () => void;
}

const MAX_SHOWN = 80;

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  fontSize: "13px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  boxSizing: "border-box",
  backgroundColor: "#fff",
};

const groupStyle: React.CSSProperties = { padding: "5px 10px", fontSize: "11px", fontWeight: 800, color: "#64748b", backgroundColor: "#f1f5f9" };

const itemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 10px",
  fontSize: "13px",
  border: "none",
  borderBottom: "1px solid #f1f5f9",
  backgroundColor: "#fff",
  color: "#0f172a",
  cursor: "pointer",
};

/** 등록된 상품을 "소 등심 1++ 국내산" 한 줄로 검색해서 고른다. 글자를 치면 그 글자가 든 품목만 남는다. */
export function ProductPicker({ labeled, labelById, recentIds, selectedId, fallbackLabel, ariaLabel, onPick, onCreateNew }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selectedLabel = labelById.get(selectedId);

  const { groups, hiddenCount } = useMemo(() => {
    // 닫힌 줄은 계산하지 않는다 — 300줄 발주서에서 줄마다 5,000개를 거르면 화면이 멈춘다.
    if (!open) {
      return { groups: [] as Array<{ title: string; items: LabeledProduct[] }>, hiddenCount: 0 };
    }

    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matched = labeled.filter((item) => tokens.every((token) => item.label.toLowerCase().includes(token)));
    const recentRank = new Map(recentIds.map((id, index) => [id, index]));
    const recent =
      tokens.length === 0
        ? matched
            .filter((item) => recentRank.has(item.option.id))
            .sort((a, b) => recentRank.get(a.option.id)! - recentRank.get(b.option.id)!)
            .slice(0, 8)
        : [];
    const recentSet = new Set(recent.map((item) => item.option.id));
    const rest = matched.filter((item) => !recentSet.has(item.option.id));
    const shownRest = rest.slice(0, MAX_SHOWN);
    const byCategory = new Map<string, LabeledProduct[]>();

    for (const item of shownRest) {
      byCategory.set(item.option.category, [...(byCategory.get(item.option.category) ?? []), item]);
    }

    return {
      groups: [
        ...(recent.length > 0 ? [{ title: "최근 사용", items: recent }] : []),
        ...[...byCategory.entries()].map(([title, items]) => ({ title, items })),
      ],
      hiddenCount: rest.length - shownRest.length,
    };
  }, [open, labeled, query, recentIds]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <div
      style={{ position: "relative" }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <input
        aria-label={ariaLabel}
        value={open ? query : (selectedLabel ?? "")}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={selectedLabel ? "" : fallbackLabel ? `${fallbackLabel} (등록 안 됨)` : "품목 검색 — 예: 소 등심 1++"}
        autoComplete="off"
        style={{ ...inputStyle, borderColor: selectedLabel ? "#93c5fd" : "#cbd5e1", fontWeight: selectedLabel ? 700 : 400 }}
      />
      {open && (
        <div
          role="listbox"
          // Safari는 버튼을 눌러도 포커스가 안 옮겨져 목록이 먼저 닫히고 선택이 씹힌다 — 마우스를 누르는 동안 입력창 포커스를 유지한다.
          onMouseDown={(event) => event.preventDefault()}
          style={{
            position: "absolute",
            zIndex: 20,
            left: 0,
            right: 0,
            top: "100%",
            marginTop: "4px",
            maxHeight: "320px",
            overflowY: "auto",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            backgroundColor: "#fff",
            boxShadow: "0 8px 24px rgba(15,23,42,0.15)",
          }}
        >
          {groups.length === 0 && (
            <div style={{ padding: "10px", fontSize: "12px", color: "#64748b" }}>
              {labeled.length === 0 ? "등록된 품목이 없습니다." : "맞는 품목이 없습니다."}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.title}>
              <div style={groupStyle}>{group.title}</div>
              {group.items.map((item) => (
                <button
                  key={`${group.title}-${item.option.id}`}
                  type="button"
                  role="option"
                  aria-selected={item.option.id === selectedId}
                  style={{ ...itemStyle, backgroundColor: item.option.id === selectedId ? "#eff6ff" : "#fff" }}
                  onClick={() => {
                    onPick(item.option);
                    close();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
          {hiddenCount > 0 && (
            <div style={{ padding: "8px 10px", fontSize: "12px", color: "#64748b" }}>{hiddenCount}개가 더 있습니다. 글자를 더 입력해 좁혀주세요.</div>
          )}
          <button
            type="button"
            style={{ ...itemStyle, position: "sticky", bottom: 0, fontWeight: 800, color: "#1d4ed8", backgroundColor: "#eff6ff", borderBottom: "none" }}
            onClick={() => {
              onCreateNew();
              close();
            }}
          >
            + 새 품목 만들기
          </button>
        </div>
      )}
    </div>
  );
}
