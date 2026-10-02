import { formatWon } from "@/lib/orders/status";
import type { OrderMarginSummary } from "@/lib/supplier/order-margin";
import type { OrderStatus } from "@/types/database";

const cardStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "16px",
} as const;

function formatQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function formatRate(rate: number | null): string {
  return rate === null ? "-" : `${rate}%`;
}

function marginColor(amount: number): string {
  return amount < 0 ? "#b91c1c" : "#166534";
}

/**
 * 주문별 원가·마진 — 대표(owner)만 보는 박스. 부르는 쪽(page.tsx)이 대표가 아니면 아예 렌더하지 않고,
 * 데이터도 DB 함수(get_order_margin)가 대표에게만 준다.
 */
export function OrderMarginPanel({ summary, status }: { summary: OrderMarginSummary; status: OrderStatus }) {
  const isEstimate = status === "confirmed";

  return (
    <section style={{ ...cardStyle, borderColor: "#bbf7d0", backgroundColor: "#f0fdf4" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#14532d" }}>원가 관리 · 이 주문의 마진</span>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 700,
            color: "#166534",
            backgroundColor: "#dcfce7",
            borderRadius: "6px",
            padding: "2px 7px",
          }}
        >
          허용된 사람만 보여요
        </span>
        {isEstimate && (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: "#92400e",
              backgroundColor: "#fef3c7",
              borderRadius: "6px",
              padding: "2px 7px",
            }}
          >
            출고 전 예상
          </span>
        )}
      </div>

      <p style={{ fontSize: "12px", color: "#475569", lineHeight: 1.6, marginBottom: "10px" }}>
        {isEstimate
          ? "아직 나가기 전이라, 먼저 들어온 박스부터 자동으로 잡은 기준의 예상입니다. 출고 스캔에서 다른 박스를 찍으면 달라질 수 있어요."
          : "실제로 나간 박스의 매입단가로 계산했어요."}
      </p>

      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "11px", color: "#64748b" }}>판매금액</div>
          <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{formatWon(summary.salesAmount)}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: "#64748b" }}>원가</div>
          <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{formatWon(summary.costAmount)}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: "#64748b" }}>마진</div>
          <div style={{ fontSize: "16px", fontWeight: 800, color: marginColor(summary.marginAmount) }}>
            {formatWon(summary.marginAmount)} ({formatRate(summary.marginRate)})
            {summary.incomplete && <span style={{ fontSize: "11px", color: "#b45309", marginLeft: "6px" }}>미완성</span>}
          </div>
        </div>
      </div>

      {summary.incomplete && (
        <p
          style={{
            fontSize: "12px",
            fontWeight: 700,
            color: "#92400e",
            backgroundColor: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: "8px",
            padding: "8px 10px",
            lineHeight: 1.6,
            marginBottom: "12px",
          }}
        >
          매입단가를 모르는 물량이 {formatQty(summary.unpricedQty)}kg 있어요. 그만큼은 원가에 빠져 있어서 마진이 실제보다 높게 보입니다.
          입고 때 단가를 넣지 않은 박스이거나 박스 없이 수동으로 넣은 재고예요. 단가는 [회계 관리]의 매입 정산에서 채울 수 있습니다.
        </p>
      )}

      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th>상품명</th>
              <th>판매금액</th>
              <th>원가</th>
              <th>마진</th>
              <th>마진율</th>
            </tr>
          </thead>
          <tbody>
            {summary.lines.map((line) => (
              <tr key={line.productId ?? line.productName}>
                <td style={{ fontWeight: 600 }}>
                  {line.productName}
                  {line.incomplete && (
                    <span style={{ fontSize: "11px", color: "#b45309", marginLeft: "6px" }}>
                      원가 미입력 {formatQty(line.unpricedQty)}
                      {line.unit}
                    </span>
                  )}
                </td>
                <td>{formatWon(line.salesAmount)}</td>
                <td>{formatWon(line.costAmount)}</td>
                <td style={{ fontWeight: 700, color: marginColor(line.marginAmount) }}>{formatWon(line.marginAmount)}</td>
                <td>{formatRate(line.marginRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
