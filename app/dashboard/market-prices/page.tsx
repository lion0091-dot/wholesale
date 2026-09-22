import { MarketPriceBoard } from "./market-price-board";

/**
 * 공공 경락가 화면 (공급사 전용).
 *
 * 상품관리에는 "내가 파는 상품 줄마다 그 등급의 공공가"만 붙어 있다. 여기는
 * 내가 취급하지 않는 품목까지 포함해 축종별 전 등급을 통째로 보는 화면이다.
 *
 * 데이터 접근 제어는 DB에 있다 — market_price_snapshots의 SELECT RLS가 공급사와
 * 관리자로 한정돼 있어(20260930000056), 고객 계정으로는 조회해도 0건이 나온다.
 */
export default function MarketPricesPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>
          공공 시세
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          축산물품질평가원이 공개하는 도매시장 경락가입니다. 매일 한 번 갱신되며,
          내 판매가를 정할 때 참고용으로 씁니다. 고객에게는 보이지 않습니다.
        </p>
      </header>

      <MarketPriceBoard />
    </div>
  );
}
