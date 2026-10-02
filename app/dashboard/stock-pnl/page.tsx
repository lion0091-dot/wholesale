import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { FeatureNotice } from "@/components/feature-notice";
import { FEATURE_KEYS, getMyEnabledFeatures } from "@/lib/features/my-features";
import { formatWon } from "@/lib/orders/status";
import { fetchPnl, formatMonthLabel, formatQty, productGrossProfit, summarizePnl } from "@/lib/supplier/pnl";
import { AccountingTabs } from "../section-tabs";

export const metadata = {
  title: "손익 관리 | 도매업체 통합관리시스템",
};

/** DB(resolve_pnl_scope)와 같은 상한 — 넘으면 DB가 거부하므로 화면이 먼저 안내한다. */
const MAX_RANGE_DAYS = 366;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const cardStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "10px 14px",
} as const;

const inputStyle = {
  fontSize: "13px",
  padding: "7px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
} as const;

const thStyle = { padding: "6px 10px", textAlign: "right" } as const;
const tdStyle = { padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" } as const;

/** 한국 시간 기준 오늘(YYYY-MM-DD). */
function kstToday(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${rate}%`;
}

/**
 * 회계 관리 > 손익 관리 — 기간별 매출·매출원가·매출총이익(마진)과 폐기·손실 금액(마이그레이션 219). 조회 전용.
 * 영업이익이 아니다: 인건비·임대료 같은 비용은 시스템에 없어 넣지 않았다.
 * 매출 = 출고 확정된 주문(취소 제외), 매출원가 = 나간 박스의 매입단가 × 출고량. 원가를 모르는 출고와 금액을 모르는 손실은
 * 0원으로 치지 않고 따로 보여준다. 대표만, 회계 관리의 이 탭이 켜져 있을 때만 열린다.
 */
export default async function PnlPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  if (scope?.wholesalerId && !(await getMyEnabledFeatures()).has(FEATURE_KEYS.accountingPnl)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <AccountingTabs />
        <FeatureNotice screenName="손익 관리">
          이 업체에서는 쓰지 않도록 설정된 기능이에요. 필요하면 운영팀에 문의해 주세요.
        </FeatureNotice>
      </div>
    );
  }

  const params = await searchParams;
  const pick = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]);
  const today = kstToday();
  const fromParam = pick("from");
  const toParam = pick("to");
  const from = fromParam && DATE_PATTERN.test(fromParam) ? fromParam : `${today.slice(0, 8)}01`;
  const to = toParam && DATE_PATTERN.test(toParam) ? toParam : today;
  const rangeError =
    from > to
      ? "시작일이 종료일보다 늦습니다."
      : daysBetween(from, to) > MAX_RANGE_DAYS
        ? `조회 기간은 최대 ${MAX_RANGE_DAYS}일까지입니다.`
        : null;

  const result = scope?.wholesalerId && !rangeError ? await fetchPnl(await createClient(), { from, to }) : null;

  const header = (
    <>
      <AccountingTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>손익 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0", lineHeight: 1.6 }}>
          기간 안에 <strong>출고가 확정된 주문</strong>(취소 제외)의 매출에서, 실제로 나간 박스의 <strong>매입 원가</strong>를 뺀{" "}
          <strong>매출총이익(마진)</strong>입니다. 인건비·임대료 같은 비용은 들어 있지 않아 영업이익이 아니에요. 원가를 모르는 출고와 금액을 모르는
          손실은 0원으로 치지 않고 따로 표시합니다.
        </p>
      </header>

      <form method="get" style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <input type="date" name="from" defaultValue={from} aria-label="시작일" style={inputStyle} />
        <span style={{ fontSize: "13px", color: "#64748b" }}>~</span>
        <input type="date" name="to" defaultValue={to} aria-label="종료일" style={inputStyle} />
        <button
          type="submit"
          style={{ ...inputStyle, fontWeight: 700, backgroundColor: "#1d4ed8", color: "#ffffff", border: "1px solid #1d4ed8", cursor: "pointer" }}
        >
          조회
        </button>
      </form>
    </>
  );

  if (rangeError) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        {header}
        <p role="alert" style={{ fontSize: "13px", color: "#b91c1c", margin: 0 }}>
          {rangeError}
        </p>
      </div>
    );
  }

  if (!result) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <AccountingTabs />
        <FeatureNotice screenName="손익 관리">
          손익 관리는 대표님만 볼 수 있어요. 매출·원가·마진이 들어 있기 때문입니다.
        </FeatureNotice>
      </div>
    );
  }

  const { months, products } = result;
  const totals = summarizePnl(months);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {header}

      {months.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>이 기간에 출고가 확정된 주문과 손실 기록이 없습니다.</p>
      ) : (
        <>
          <section className="dash-cards">
            {[
              { label: `매출 (주문 ${totals.orderCount}건)`, value: formatWon(totals.salesAmount), accent: "#0f172a" },
              { label: "매출원가", value: formatWon(totals.costAmount), accent: "#475569" },
              {
                label: `매출총이익 · 마진율 ${formatRate(totals.marginRate)}`,
                value: formatWon(totals.grossProfit),
                accent: totals.grossProfit < 0 ? "#b91c1c" : "#166534",
              },
              { label: "폐기·손실 금액(금액 아는 것)", value: formatWon(totals.lossAmount), accent: "#b91c1c" },
              {
                label: "손실 반영 후 이익",
                value: formatWon(totals.profitAfterLoss),
                accent: totals.profitAfterLoss < 0 ? "#b91c1c" : "#166534",
              },
            ].map((card) => (
              <div key={card.label} style={{ ...cardStyle, padding: "14px 16px" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>{card.label}</div>
                <div style={{ fontSize: "20px", fontWeight: 800, color: card.accent, marginTop: "4px" }}>{card.value}</div>
              </div>
            ))}
          </section>

          {(totals.unpricedItems > 0 || totals.lossUnpricedEvents > 0) && (
            <p
              role="note"
              style={{ margin: 0, fontSize: "13px", color: "#92400e", backgroundColor: "#fffbeb", border: "1px solid #fde68a", borderRadius: "10px", padding: "10px 14px", lineHeight: 1.6 }}
            >
              숫자가 완전하지 않아요.
              {totals.unpricedItems > 0 && <> 원가를 모르는 출고가 있는 상품이 {totals.unpricedItems}건 있어 매출총이익이 실제보다 커 보일 수 있습니다(매입단가가 없는 박스, 박스 없는 재고).</>}
              {totals.lossUnpricedEvents > 0 && <> 금액을 모르는 손실 기록이 {totals.lossUnpricedEvents}건 있어 손실 금액에 들어가지 않았습니다.</>}
              {" "}자세한 내용은 아래 상품별 표의 &quot;원가 미입력&quot;·&quot;금액 미상&quot; 열에서 확인하세요.
            </p>
          )}

          <section style={{ ...cardStyle, padding: "8px 4px", overflowX: "auto" }}>
            <h2 style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a", margin: "4px 10px 8px" }}>월별</h2>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: "#64748b" }}>
                  <th style={{ ...thStyle, textAlign: "left" }}>월</th>
                  <th style={thStyle}>주문</th>
                  <th style={thStyle}>매출</th>
                  <th style={thStyle}>매출원가</th>
                  <th style={thStyle}>매출총이익</th>
                  <th style={thStyle}>마진율</th>
                  <th style={thStyle}>손실 금액</th>
                  <th style={thStyle}>미완성</th>
                </tr>
              </thead>
              <tbody>
                {months.map((row) => {
                  const gross = row.salesAmount - row.costAmount;

                  return (
                    <tr key={row.monthStart} style={{ borderTop: "1px solid #f1f5f9" }}>
                      <td style={{ ...tdStyle, textAlign: "left", fontWeight: 700 }}>{formatMonthLabel(row.monthStart)}</td>
                      <td style={tdStyle}>{row.orderCount}</td>
                      <td style={tdStyle}>{formatWon(row.salesAmount)}</td>
                      <td style={tdStyle}>{formatWon(row.costAmount)}</td>
                      <td style={{ ...tdStyle, fontWeight: 700, color: gross < 0 ? "#b91c1c" : "#166534" }}>{formatWon(gross)}</td>
                      <td style={tdStyle}>{formatRate(row.salesAmount > 0 ? Math.round((gross / row.salesAmount) * 1000) / 10 : null)}</td>
                      <td style={tdStyle}>{formatWon(row.lossAmount)}</td>
                      <td style={{ ...tdStyle, color: "#b45309" }}>
                        {row.unpricedItems > 0 && <>원가 미입력 {row.unpricedItems}</>}
                        {row.unpricedItems > 0 && row.lossUnpricedEvents > 0 && " · "}
                        {row.lossUnpricedEvents > 0 && <>손실 금액 미상 {row.lossUnpricedEvents}</>}
                        {row.unpricedItems === 0 && row.lossUnpricedEvents === 0 && "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section style={{ ...cardStyle, padding: "8px 4px", overflowX: "auto" }}>
            <h2 style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a", margin: "4px 10px 8px" }}>상품별 (매출 큰 순)</h2>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: "#64748b" }}>
                  <th style={{ ...thStyle, textAlign: "left" }}>상품</th>
                  <th style={thStyle}>출고량</th>
                  <th style={thStyle}>매출</th>
                  <th style={thStyle}>매출원가</th>
                  <th style={thStyle}>매출총이익</th>
                  <th style={thStyle}>마진율</th>
                  <th style={thStyle}>원가 미입력</th>
                  <th style={thStyle}>폐기·손실</th>
                  <th style={thStyle}>손실 금액</th>
                </tr>
              </thead>
              <tbody>
                {products.map((row) => {
                  const { grossProfit, marginRate } = productGrossProfit(row);

                  return (
                    <tr key={row.productId} style={{ borderTop: "1px solid #f1f5f9" }}>
                      <td style={{ ...tdStyle, textAlign: "left", fontWeight: 700 }}>{row.productName}</td>
                      <td style={tdStyle}>
                        {formatQty(row.shippedQty)}
                        {row.unit}
                      </td>
                      <td style={tdStyle}>{formatWon(row.salesAmount)}</td>
                      <td style={tdStyle}>{formatWon(row.costAmount)}</td>
                      <td style={{ ...tdStyle, fontWeight: 700, color: grossProfit < 0 ? "#b91c1c" : "#166534" }}>{formatWon(grossProfit)}</td>
                      <td style={{ ...tdStyle, color: row.unpricedQty > 0 ? "#b45309" : undefined }}>
                        {formatRate(marginRate)}
                        {row.unpricedQty > 0 && marginRate !== null && "*"}
                      </td>
                      <td style={{ ...tdStyle, color: row.unpricedQty > 0 ? "#b45309" : undefined }}>
                        {row.unpricedQty > 0 ? `${formatQty(row.unpricedQty)}${row.unit}` : "—"}
                      </td>
                      <td style={tdStyle}>
                        {row.lossQty > 0 ? `${formatQty(row.lossQty)}${row.unit}` : "—"}
                      </td>
                      <td style={tdStyle}>
                        {row.lossQty === 0 ? (
                          "—"
                        ) : (
                          <>
                            {formatWon(row.lossAmount)}
                            {row.lossUnpricedQty > 0 && (
                              <span style={{ color: "#b45309" }}> · 금액 미상 {formatQty(row.lossUnpricedQty)}{row.unit}</span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {products.some((row) => row.unpricedQty > 0) && (
              <p style={{ fontSize: "12px", color: "#b45309", margin: "8px 10px 4px" }}>
                * 원가를 모르는 출고가 포함돼 실제 마진율보다 높게 보입니다. 매입단가는 회계 관리의 매입 정산에서 채울 수 있어요.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
