"use client";

import { useEffect, useState } from "react";
import {
  getProductStockBreakdownAction,
  type ProductStockBreakdownRow,
} from "@/app/dashboard/products/actions";

interface ProductStockBreakdownWidgetProps {
  productId: string;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * 상품 수정 화면에서 핫딜 켤지 판단할 때 "오래된 재고가 얼마나 남았는지" 보여주는 위젯.
 * get_product_stock_breakdown RPC를 그대로 감싼 서버 액션을 호출한다(신규 등록 시에는
 * 아직 입고 박스가 없으므로 이 위젯 자체를 렌더링하지 않는다).
 */
export function ProductStockBreakdownWidget({ productId }: ProductStockBreakdownWidgetProps) {
  const [rows, setRows] = useState<ProductStockBreakdownRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getProductStockBreakdownAction(productId).then((result) => {
      if (cancelled) return;

      if (result.success) {
        setRows(result.data ?? []);
      } else {
        setError(result.error ?? "재고 구성을 불러오지 못했습니다.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [productId]);

  const totalWeight = (rows ?? []).reduce((sum, row) => sum + row.remainingWeight, 0);

  return (
    <div
      style={{
        marginTop: "10px",
        backgroundColor: "#fffbeb",
        border: "1px solid #fde68a",
        borderRadius: "8px",
        padding: "12px 14px",
      }}
    >
      <div style={{ fontSize: "11px", fontWeight: 700, color: "#92400e" }}>
        📦 남은 재고 구성 (입고 오래된 순 · 핫딜 판단용)
      </div>

      {error && <p style={{ fontSize: "12px", color: "#b91c1c", marginTop: "6px" }}>{error}</p>}

      {!error && rows === null && (
        <p style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>불러오는 중...</p>
      )}

      {!error && rows !== null && rows.length === 0 && (
        <p style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>
          이력번호 입고 스캔으로 등록된 남은 재고가 없습니다.
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <>
          <ul
            style={{
              listStyle: "none",
              margin: "6px 0 0",
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}
          >
            {rows.map((row) => (
              <li
                key={row.boxId}
                style={{
                  fontSize: "12px",
                  color: "#78350f",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
                <span>
                  {formatDate(row.scannedAt)} 입고 · {row.traceNo}
                </span>
                <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                  {row.remainingWeight.toLocaleString("ko-KR")}
                  {row.unit}
                  {row.bestBefore ? ` · ~${row.bestBefore}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: "11px", color: "#92400e", marginTop: "8px", fontWeight: 600 }}>
            합계 {totalWeight.toLocaleString("ko-KR")}
            {rows[0].unit} · {rows.length}박스
          </p>
        </>
      )}
    </div>
  );
}
