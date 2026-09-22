"use client";

import { useState } from "react";
import { MarketPriceWidget } from "@/components/market-price-widget";

/** 시세 데이터가 있는 축종만 — 그 외(닭/오리, 양, 가공육)는 공공 경락가가 없다. */
const SPECIES_TABS = ["소", "돼지"] as const;

/**
 * 공공 경락가 전용 화면(/dashboard/market-prices).
 *
 * 상품관리에는 "내가 파는 상품 줄마다 그 등급의 공공가"만 붙인다. 여기는 그와 달리
 * 내가 안 파는 품목까지 포함해 축종별 전 등급 시세를 통째로 보는 화면이다 —
 * 도매업체가 "다른 부위·등급은 얼마나 하나"를 확인하는 용도.
 *
 * 고객(식당)에게는 노출되지 않는다 — 미니샵에는 이 화면이 없고, DB 쪽에서도
 * market_price_snapshots 조회를 공급사/관리자로 제한해뒀다
 * (20260930000056_product_stock_freshness.sql).
 */
export function MarketPriceBoard() {
  const [openSpecies, setOpenSpecies] = useState<(typeof SPECIES_TABS)[number] | null>(
    SPECIES_TABS[0]
  );

  return (
    <section
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        backgroundColor: "#fff",
        padding: "12px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>축종별 전 등급 시세</span>
        <span style={{ fontSize: "11px", color: "#94a3b8" }}>공급사 전용 · 고객에게는 보이지 않습니다</span>

        <div style={{ marginLeft: "auto", display: "flex", gap: "6px" }}>
          {SPECIES_TABS.map((species) => {
            const isOpen = openSpecies === species;

            return (
              <button
                key={species}
                type="button"
                onClick={() => setOpenSpecies(isOpen ? null : species)}
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  padding: "6px 12px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  border: isOpen ? "1px solid #0f172a" : "1px solid #e2e8f0",
                  backgroundColor: isOpen ? "#0f172a" : "#f8fafc",
                  color: isOpen ? "#fff" : "#475569",
                }}
              >
                {species}
              </button>
            );
          })}
        </div>
      </div>

      {openSpecies ? (
        <div style={{ marginTop: "10px" }}>
          <MarketPriceWidget category={openSpecies} />
        </div>
      ) : null}
    </section>
  );
}
