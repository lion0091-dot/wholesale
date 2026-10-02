import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { FeatureNotice } from "@/components/feature-notice";
import { FEATURE_KEYS, getMyEnabledFeatures } from "@/lib/features/my-features";
import { formatWon } from "@/lib/orders/status";
import { formatMonthLabel } from "@/lib/supplier/pnl";
import { fetchTaxInvoiceSummary, summarizeTaxInvoices, TODO_KIND_LABEL } from "@/lib/supplier/tax-invoice-summary";
import { AccountingTabs } from "../section-tabs";

export const metadata = {
  title: "계산서 집계 | 도매업체 통합관리시스템",
};

/** DB(resolve_tax_invoice_scope)와 같은 상한 — 넘으면 DB가 거부하므로 화면이 먼저 안내한다. */
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

const linkStyle = { fontSize: "12px", fontWeight: 700, color: "#1d4ed8", textDecoration: "none" } as const;

/** 한국 시간 기준 오늘(YYYY-MM-DD). */
function kstToday(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * 회계 관리 > 계산서 집계 — 기간별로 발행한 계산서(면세)의 건수·금액을 월별·거래처별로 모아 본다(마이그레이션 222). 조회 전용.
 * 금액은 발행 완료한 최초 발행의 주문 총액 합계다. 정정 발행은 건수만 따로 세고, 진행 중(결과 모름)·실패 건은 금액에 넣지 않고 따로 보여준다.
 * 대표·매니저만, 회계 관리의 이 탭이 켜져 있을 때만 열린다.
 */
export default async function TaxInvoiceSummaryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  if (scope?.wholesalerId && !(await getMyEnabledFeatures()).has(FEATURE_KEYS.accountingTaxInvoices)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <AccountingTabs />
        <FeatureNotice screenName="계산서 집계">
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

  const result = scope?.wholesalerId && !rangeError ? await fetchTaxInvoiceSummary(await createClient(), { from, to }) : null;

  const header = (
    <>
      <AccountingTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>계산서 집계</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0", lineHeight: 1.6 }}>
          기간 안에 국세청에 <strong>발행 완료한 계산서(면세)</strong>의 건수와 금액입니다. 금액은 주문 총액이고, 같은 주문을 고쳐 다시 신고한{" "}
          <strong>정정 발행</strong>은 금액에 합치지 않고 건수만 따로 셉니다. 결과를 아직 모르는 건(진행 중)과 실패한 건도 따로 표시합니다.
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
        <FeatureNotice screenName="계산서 집계">
          계산서 집계는 대표님과 매니저만 볼 수 있어요. 계산서를 발행하고 조회하는 권한과 같습니다.
        </FeatureNotice>
      </div>
    );
  }

  const { months, retailers, todo, todoTotal } = result;
  const exportHref = (kind: string) => `/dashboard/tax-invoices/export?kind=${kind}&from=${from}&to=${to}`;
  const totals = summarizeTaxInvoices(months);

  const todoSection = todo.length > 0 && (
    <section style={{ ...cardStyle, padding: "8px 4px", overflowX: "auto", borderColor: "#fde68a" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "4px 10px 8px", gap: "8px", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "14px", fontWeight: 800, color: "#92400e", margin: 0 }}>
          챙겨야 할 주문 {todoTotal}건
          {todoTotal > todo.length && <span style={{ fontWeight: 500, color: "#64748b" }}> (최근 {todo.length}건만 표시)</span>}
        </h2>
        <a href={exportHref("todo")} style={linkStyle}>엑셀(CSV)로 받기</a>
      </div>
      <p style={{ fontSize: "12px", color: "#64748b", margin: "0 10px 8px", lineHeight: 1.6 }}>
        주문번호를 누르면 그 주문 화면으로 가요. 진행 중은 팝빌에서 접수 여부를 확인해 정리해야 재발행할 수 있고, 실패와 &quot;계산서 없음&quot;은 주문 화면에서 계산서를 발행하면 목록에서 사라집니다.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr style={{ color: "#64748b" }}>
            <th style={{ ...thStyle, textAlign: "left" }}>구분</th>
            <th style={{ ...thStyle, textAlign: "left" }}>주문번호</th>
            <th style={{ ...thStyle, textAlign: "left" }}>거래처</th>
            <th style={thStyle}>주문 금액</th>
            <th style={thStyle}>일시</th>
          </tr>
        </thead>
        <tbody>
          {todo.map((row) => (
            <tr key={`${row.kind}-${row.orderId}-${row.happenedAt}`} style={{ borderTop: "1px solid #f1f5f9" }}>
              <td
                style={{
                  ...tdStyle,
                  textAlign: "left",
                  fontWeight: 700,
                  color: row.kind === "failed" ? "#b91c1c" : row.kind === "pending" ? "#b45309" : "#475569",
                }}
              >
                {TODO_KIND_LABEL[row.kind]}
                {row.errorMessage && <div style={{ fontSize: "11px", fontWeight: 400, color: "#64748b", whiteSpace: "normal" }}>{row.errorMessage}</div>}
              </td>
              <td style={{ ...tdStyle, textAlign: "left" }}>
                <Link href={`/dashboard/orders/${row.orderId}`} style={linkStyle}>
                  {row.orderNumber}
                </Link>
              </td>
              <td style={{ ...tdStyle, textAlign: "left" }}>{row.retailerName}</td>
              <td style={tdStyle}>{formatWon(row.totalAmount)}</td>
              <td style={tdStyle}>{row.happenedAt.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {header}

      {todoSection}

      {months.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>이 기간에 발행한 계산서가 없습니다.</p>
      ) : (
        <>
          <section className="dash-cards">
            {[
              { label: `발행 완료 (${totals.issuedCount}건)`, value: formatWon(totals.issuedAmount), accent: "#0f172a" },
              { label: "정정 발행", value: `${totals.correctedCount}건`, accent: "#475569" },
              { label: "진행 중(결과 모름)", value: `${totals.pendingCount}건`, accent: totals.pendingCount > 0 ? "#b45309" : "#475569" },
              { label: "실패", value: `${totals.failedCount}건`, accent: totals.failedCount > 0 ? "#b91c1c" : "#475569" },
            ].map((card) => (
              <div key={card.label} style={{ ...cardStyle, padding: "14px 16px" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>{card.label}</div>
                <div style={{ fontSize: "20px", fontWeight: 800, color: card.accent, marginTop: "4px" }}>{card.value}</div>
              </div>
            ))}
          </section>

          {(totals.pendingCount > 0 || totals.failedCount > 0) && (
            <p
              role="note"
              style={{ margin: 0, fontSize: "13px", color: "#92400e", backgroundColor: "#fffbeb", border: "1px solid #fde68a", borderRadius: "10px", padding: "10px 14px", lineHeight: 1.6 }}
            >
              확인이 필요한 건이 있어요.
              {totals.pendingCount > 0 && <> 진행 중 {totals.pendingCount}건은 국세청에 접수됐는지 결과를 모르는 상태라, 팝빌에서 확인해 정리하기 전까지 같은 주문의 재발행이 막힙니다.</>}
              {totals.failedCount > 0 && <> 실패 {totals.failedCount}건은 금액에 들어가지 않았어요. 아래 "챙겨야 할 주문"에서 주문 화면으로 가서 다시 발행할 수 있어요.</>}
            </p>
          )}

          <section style={{ ...cardStyle, padding: "8px 4px", overflowX: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "4px 10px 8px" }}>
              <h2 style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a", margin: 0 }}>월별</h2>
              <a href={exportHref("months")} style={linkStyle}>엑셀(CSV)로 받기</a>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: "#64748b" }}>
                  <th style={{ ...thStyle, textAlign: "left" }}>월</th>
                  <th style={thStyle}>발행 건수</th>
                  <th style={thStyle}>발행 금액</th>
                  <th style={thStyle}>정정 발행</th>
                  <th style={thStyle}>진행 중</th>
                  <th style={thStyle}>실패</th>
                </tr>
              </thead>
              <tbody>
                {months.map((row) => (
                  <tr key={row.monthStart} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ ...tdStyle, textAlign: "left", fontWeight: 700 }}>{formatMonthLabel(row.monthStart)}</td>
                    <td style={tdStyle}>{row.issuedCount}</td>
                    <td style={tdStyle}>{formatWon(row.issuedAmount)}</td>
                    <td style={tdStyle}>{row.correctedCount || "—"}</td>
                    <td style={{ ...tdStyle, color: row.pendingCount > 0 ? "#b45309" : undefined }}>{row.pendingCount || "—"}</td>
                    <td style={{ ...tdStyle, color: row.failedCount > 0 ? "#b91c1c" : undefined }}>{row.failedCount || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section style={{ ...cardStyle, padding: "8px 4px", overflowX: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "4px 10px 8px" }}>
              <h2 style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a", margin: 0 }}>거래처별 (발행 금액 큰 순)</h2>
              <a href={exportHref("retailers")} style={linkStyle}>엑셀(CSV)로 받기</a>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: "#64748b" }}>
                  <th style={{ ...thStyle, textAlign: "left" }}>거래처</th>
                  <th style={thStyle}>발행 건수</th>
                  <th style={thStyle}>발행 금액</th>
                  <th style={thStyle}>정정 발행</th>
                  <th style={thStyle}>진행 중</th>
                  <th style={thStyle}>실패</th>
                </tr>
              </thead>
              <tbody>
                {retailers.map((row) => (
                  <tr key={row.retailerId} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ ...tdStyle, textAlign: "left", fontWeight: 700 }}>{row.retailerName}</td>
                    <td style={tdStyle}>{row.issuedCount}</td>
                    <td style={tdStyle}>{formatWon(row.issuedAmount)}</td>
                    <td style={tdStyle}>{row.correctedCount || "—"}</td>
                    <td style={{ ...tdStyle, color: row.pendingCount > 0 ? "#b45309" : undefined }}>{row.pendingCount || "—"}</td>
                    <td style={{ ...tdStyle, color: row.failedCount > 0 ? "#b91c1c" : undefined }}>{row.failedCount || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
