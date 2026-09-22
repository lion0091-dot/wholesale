"use client";

import { useState } from "react";
import { MarketPriceWidget } from "@/components/market-price-widget";

/** 시세 데이터가 있는 축종만 — 그 외(닭/오리, 양, 가공육)는 공공 경락가가 없다. */
const SPECIES_TABS = ["소", "돼지"] as const;

/**
 * 상품관리 화면 상단의 공공 경락가 패널.
 *
 * 공급사가 자기 판매가를 정할 때 오늘 도매시장 시세를 같이 보라고 두는 참고용이다.
 * 고객(식당)에게는 노출되지 않는다 — 미니샵에는 이 컴포넌트를 쓰지 않고,
 * DB 쪽에서도 market_price_snapshots 조회를 공급사/관리자로 제한해뒀다
 * (20260930000056_product_stock_freshness.sql).
 *
 * 화면을 처음 열자마자 펼쳐두면 상품 목록이 아래로 밀려서, 기본은 접어둔다.
 */
export function MarketPricePanel() {
  const [openSpecies, setOpenSpecies] = useState<(typeof SPECIES_TABS)[number] | null>(null);

  return (
    <section
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        backgroundColor: "#fff",
        padding: "12px 14px",
        marginBottom: "14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>오늘 도매시장 시세</span>
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
