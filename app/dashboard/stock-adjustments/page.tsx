import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { FeatureNotice } from "@/components/feature-notice";
import { FEATURE_KEYS, getMyEnabledFeatures } from "@/lib/features/my-features";
import { formatWon } from "@/lib/orders/status";
import {
  KIND_FILTERS,
  fetchStockAdjustments,
  formatAdjustQty,
  kindLabel,
  parseKindFilter,
} from "@/lib/supplier/stock-adjustments";
import { AccountingTabs } from "../section-tabs";

export const metadata = {
  title: "재고 조정·손실 | 도매업체 통합관리시스템",
};

/** 기본 조회 기간(일). 손실은 보통 "이번 달"을 본다. */
const DEFAULT_DAYS = 30;
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

/** 한국 시간 기준 오늘에서 days일 전 날짜(YYYY-MM-DD). */
function kstDate(daysAgo: number): string {
  return new Date(Date.now() + 9 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 회계 관리 > 재고 조정·손실 — 재고가 주문·입고 말고 다른 이유로 바뀐 기록을 한 곳에서 본다(마이그레이션 218). 조회 전용.
 * 입력은 하지 않는다: 재고 조정은 상품 관리 목록에서, 박스 폐기는 재고·매입 내역의 "소비기한" 탭에서 한다.
 * 손실 금액은 박스 폐기만 안다(중량 × 매입단가). 상품 단위로 한 조정은 금액이 없어 "금액 미상"으로 따로 센다.
 * 대표만, 회계 관리의 이 탭이 켜져 있을 때만 열린다.
 */
export default async function StockAdjustmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  if (scope?.wholesalerId && !(await getMyEnabledFeatures()).has(FEATURE_KEYS.accountingStockAdjust)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <AccountingTabs />
        <FeatureNotice screenName="재고 조정·손실">
          이 업체에서는 쓰지 않도록 설정된 기능이에요. 필요하면 운영팀에 문의해 주세요.
        </FeatureNotice>
      </div>
    );
  }

  const params = await searchParams;
  const pick = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]);
  const fromParam = pick("from");
  const toParam = pick("to");
  const from = fromParam && DATE_PATTERN.test(fromParam) ? fromParam : kstDate(DEFAULT_DAYS);
  const to = toParam && DATE_PATTERN.test(toParam) ? toParam : kstDate(0);
  const kind = parseKindFilter(pick("kind"));

  const result = scope?.wholesalerId
    ? await fetchStockAdjustments(await createClient(), { from, to, kind })
    : null;

  if (!result) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <AccountingTabs />
        <FeatureNotice screenName="재고 조정·손실">
          재고 조정·손실 기록은 대표님만 볼 수 있어요. 손실 금액에 매입 원가가 들어 있기 때문입니다.
        </FeatureNotice>
      </div>
    );
  }

  const { rows, totalCount, summary } = result;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <AccountingTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>재고 조정·손실</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0", lineHeight: 1.6 }}>
          주문·입고가 아닌 이유로 재고가 바뀐 기록입니다 — 상품 목록의 재고 조정(실사·폐기·파손·반품), 박스 폐기, 장부 불일치 보정.
          손실 금액은 <strong>박스 폐기</strong>만 알 수 있어요(버린 중량 × 박스 매입단가). 상품 단위로 조정한 손실은 어느 박스인지 몰라
          금액을 0원으로 치지 않고 &quot;금액 미상&quot;으로 따로 보여줍니다.
        </p>
      </header>

      <form method="get" style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <input type="date" name="from" defaultValue={from} aria-label="시작일" style={inputStyle} />
        <span style={{ fontSize: "13px", color: "#64748b" }}>~</span>
        <input type="date" name="to" defaultValue={to} aria-label="종료일" style={inputStyle} />
        <select name="kind" defaultValue={kind ?? ""} aria-label="종류" style={inputStyle}>
          {KIND_FILTERS.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          style={{ ...inputStyle, fontWeight: 700, backgroundColor: "#1d4ed8", color: "#ffffff", border: "1px solid #1d4ed8", cursor: "pointer" }}
        >
          조회
        </button>
      </form>

      {summary.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>이 기간에 재고 조정·손실 기록이 없습니다.</p>
      ) : (
        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {summary.map((row) => (
            <div key={row.unit} style={{ ...cardStyle, display: "flex", gap: "20px", flexWrap: "wrap", alignItems: "baseline" }}>
              <div style={{ fontSize: "13px", fontWeight: 800, color: "#0f172a" }}>단위 {row.unit} · {row.eventCount}건</div>
              <div style={{ fontSize: "13px", color: "#0f172a" }}>
                폐기·손실 <strong>{formatAdjustQty(row.lossQty)}{row.unit}</strong>
                {" · "}
                금액 아는 손실 <strong style={{ color: "#b91c1c" }}>{formatWon(row.lossAmount)}</strong>
                {row.lossUnpricedQty > 0 && (
                  <span style={{ color: "#b45309" }}> · 금액 미상 {formatAdjustQty(row.lossUnpricedQty)}{row.unit}</span>
                )}
              </div>
              <div style={{ fontSize: "13px", color: "#475569" }}>
                조정으로 +{formatAdjustQty(row.adjustInQty)}{row.unit} / −{formatAdjustQty(row.adjustOutQty)}{row.unit}
              </div>
            </div>
          ))}
        </section>
      )}

      <section style={{ ...cardStyle, padding: "8px 4px", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#64748b" }}>
              <th style={{ padding: "6px 10px" }}>일시</th>
              <th style={{ padding: "6px 10px" }}>종류</th>
              <th style={{ padding: "6px 10px" }}>상품 · 박스</th>
              <th style={{ padding: "6px 10px", textAlign: "right" }}>변동</th>
              <th style={{ padding: "6px 10px", textAlign: "right" }}>손실 금액</th>
              <th style={{ padding: "6px 10px" }}>사유</th>
              <th style={{ padding: "6px 10px" }}>처리자</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: "10px", color: "#64748b" }}>
                  이 조건의 기록이 없습니다.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.ledgerId} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{formatDateTime(row.createdAt)}</td>
                <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{kindLabel(row.kind)}</td>
                <td style={{ padding: "6px 10px" }}>
                  {row.productName}
                  {row.traceNo && <span style={{ color: "#64748b" }}> · {row.traceNo}</span>}
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap", color: row.qtyDelta < 0 ? "#b91c1c" : "#166534", fontWeight: 700 }}>
                  {row.qtyDelta > 0 ? "+" : ""}
                  {formatAdjustQty(row.qtyDelta)}
                  {row.unit}
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                  {row.kind === "ADJUSTMENT" ? "—" : row.lossAmount === null ? <span style={{ color: "#b45309" }}>금액 미상</span> : formatWon(row.lossAmount)}
                </td>
                <td style={{ padding: "6px 10px", color: "#475569" }}>{row.reason}</td>
                <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{row.byName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {totalCount > rows.length && (
          <p style={{ fontSize: "12px", color: "#64748b", margin: "8px 10px 4px" }}>
            최근 {rows.length}건만 보여줍니다(전체 {totalCount}건). 기간을 좁혀서 보세요.
          </p>
        )}
      </section>
    </div>
  );
}
