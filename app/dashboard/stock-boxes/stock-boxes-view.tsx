"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { buildBoxTree, filterTree, type TreeBox, type TreeNode } from "@/lib/stock/box-tree";

export interface ShadowProduct {
  id: string;
  name: string;
  unit: string;
  sureWeight: number;
  sureBoxes: number;
  mixedWeight: number;
  mixedBoxes: number;
}

export interface PendingSummary {
  boxes: number;
  weight: number;
  capped: boolean;
}

interface Props {
  boxes: TreeBox[];
  products: ShadowProduct[];
  truncated: boolean;
  pending: PendingSummary;
}

/** 축종·부위(깊이 0·1)까지는 처음부터 펼쳐 둔다. */
const DEFAULT_OPEN_DEPTH = 2;

function formatWeight(value: number): string {
  return `${Math.round(value * 1000) / 1000}kg`;
}

function TreeRow({ node, depth, forceOpen }: { node: TreeNode; depth: number; forceOpen: boolean }) {
  const [open, setOpen] = useState(depth < DEFAULT_OPEN_DEPTH);
  const expanded = forceOpen || open;
  const hasChildren = node.children.length > 0;

  return (
    <li style={{ listStyle: "none" }}>
      <button
        type="button"
        onClick={() => hasChildren && setOpen(!open)}
        aria-expanded={hasChildren ? expanded : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          padding: "8px 10px",
          paddingLeft: `${10 + depth * 18}px`,
          background: "none",
          border: "none",
          borderBottom: "1px solid #f1f5f9",
          cursor: hasChildren ? "pointer" : "default",
          textAlign: "left",
          fontSize: "14px",
        }}
      >
        <span style={{ width: "14px", color: "#94a3b8" }}>{hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
        <span style={{ flex: 1, fontWeight: depth < 2 ? 700 : 500, color: node.label === "모름" ? "#94a3b8" : "#0f172a" }}>
          {node.label}
          {node.axis ? <span style={{ marginLeft: "6px", fontSize: "11px", color: "#94a3b8" }}>{node.axis}</span> : null}
        </span>
        <span style={{ color: "#64748b", fontSize: "13px" }}>{node.boxes}박스</span>
        <span style={{ width: "84px", textAlign: "right", fontWeight: 600 }}>{formatWeight(node.weight)}</span>
      </button>
      {hasChildren && expanded ? (
        <ul style={{ margin: 0, padding: 0 }}>
          {node.children.map((child) => (
            <TreeRow key={child.label} node={child} depth={depth + 1} forceOpen={forceOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function StockBoxesView({ boxes, products, truncated, pending }: Props) {
  const [query, setQuery] = useState("");
  const tree = useMemo(() => buildBoxTree(boxes), [boxes]);
  const shown = useMemo(() => filterTree(tree, query), [tree, query]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="부위·등급·원산지로 찾기 (예: 등심, 1++)"
        aria-label="재고 검색"
        style={{ padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "14px" }}
      />

      {pending.boxes > 0 ? (
        <p
          style={{ margin: 0, padding: "10px 12px", borderRadius: "8px", fontSize: "14px", background: "#fef3c7", color: "#92400e" }}
        >
          아직 재고에 들어가지 않은 박스가 {pending.boxes}개{pending.capped ? " 이상" : ""} 있습니다(약 {formatWeight(pending.weight)}
          {pending.capped ? " 이상" : ""}). 부위나 상품을 정해야 재고로 잡힙니다.{" "}
          <Link href="/dashboard/inbound" style={{ color: "#92400e", fontWeight: 700 }}>
            입고 화면에서 확인하기
          </Link>
        </p>
      ) : null}

      {truncated ? (
        <p style={{ margin: 0, fontSize: "13px", color: "#b45309" }}>
          박스가 너무 많아 일부만 보여줍니다. 합계가 실제보다 작을 수 있어요.
        </p>
      ) : null}

      <section style={{ border: "1px solid #e2e8f0", borderRadius: "10px", background: "#fff" }}>
        {shown === null || boxes.length === 0 ? (
          <p style={{ margin: 0, padding: "20px", color: "#64748b", fontSize: "14px" }}>
            {boxes.length === 0 ? "지금 창고에 있는 박스가 없습니다." : "찾는 재고가 없습니다."}
          </p>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", background: "#f8fafc", borderRadius: "10px 10px 0 0", fontWeight: 700 }}>
              <span>전체</span>
              <span>
                {shown.boxes}박스 · {formatWeight(shown.weight)}
              </span>
            </div>
            <ul style={{ margin: 0, padding: 0 }}>
              {shown.children.map((child) => (
                <TreeRow key={child.label} node={child} depth={0} forceOpen={query.trim() !== ""} />
              ))}
            </ul>
          </>
        )}
      </section>

      {products.length > 0 ? (
        <section>
          <h2 style={{ fontSize: "15px", fontWeight: 800, margin: "0 0 8px", color: "#0f172a" }}>상품별 재고</h2>
          <p style={{ margin: "0 0 8px", fontSize: "12px", color: "#64748b" }}>
            같은 박스가 조건이 맞는 여러 상품에 함께 잡힙니다. &quot;열어봐야 아는 것&quot;은 등급이 섞인 박스라 확실한 재고에 넣지 않았습니다.
          </p>
          <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
            {products.map((product) => (
              <li
                key={product.id}
                style={{ listStyle: "none", display: "flex", justifyContent: "space-between", gap: "8px", padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: "8px", background: "#fff", fontSize: "14px" }}
              >
                <span style={{ fontWeight: 600 }}>{product.name}</span>
                <span style={{ textAlign: "right" }}>
                  확실 {product.sureBoxes}박스 {formatWeight(product.sureWeight)}
                  {product.mixedBoxes > 0 ? (
                    <span style={{ display: "block", fontSize: "12px", color: "#b45309" }}>
                      + 열어봐야 아는 것 {product.mixedBoxes}박스 {formatWeight(product.mixedWeight)}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
