"use client";

import { useEffect, useMemo, useState } from "react";
import { buildKakaoExternalOpenUrl, isKakaoInAppBrowser } from "@/lib/kakao-in-app";
import {
  issueTaxInvoiceAction,
  issueTaxInvoiceCorrectionAction,
  listTaxInvoiceIssuancesAction,
} from "@/app/dashboard/orders/[id]/tax-invoice/issue-action";
import { MODIFY_CODE_LABELS, type ModifyCode } from "@/lib/popbill/modify-codes";
import type { TaxInvoiceIssuanceRow } from "@/lib/popbill/taxinvoice";

interface TaxInvoiceDraftPanelProps {
  /** PDF(또는 발행 불가 경고 HTML)를 돌려주는 라우트 — /dashboard/orders/[id]/tax-invoice */
  baseHref: string;
  /** 국세청 실제 발행/정정 Server Action이 필요로 하는 주문 ID */
  orderId: string;
  /** 작성일자 입력 기본값 — 보통 발주일 */
  defaultIssueDate: string;
  /**
   * 카카오톡 인앱 브라우저에서 "외부 브라우저에서 열기"를 누를 때 대신 쓸 기본 경로
   * (/doc/[token]). 세션 쿠키 없이도 서명 토큰만으로 인가된다. 없으면 baseHref로 폴백 —
   * 이 경우 외부 브라우저에서는 로그인 화면으로 튕길 수 있다.
   */
  externalOpenBaseHref?: string | null;
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "13px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "11px",
  fontWeight: 700,
  color: "#475569",
  marginBottom: "4px",
};

/**
 * 계산서(면세) 작성 초안 도우미.
 *
 * 업태/종목/비고/작성일자는 DB에 없는 값이라 이 화면에서 직접 입력받아 쿼리스트링으로
 * PDF 라우트에 넘긴다 — 저장하지 않고 미리보기/내보내기마다 그때그때 반영한다.
 * ROADMAP §7: "화면에서 수정 가능한 미리보기(초안) 폼" 요구사항.
 */
export function TaxInvoiceDraftPanel({
  baseHref,
  orderId,
  defaultIssueDate,
  externalOpenBaseHref,
}: TaxInvoiceDraftPanelProps) {
  const [open, setOpen] = useState(false);
  const [issueDate, setIssueDate] = useState(defaultIssueDate);
  const [supplierBusinessType, setSupplierBusinessType] = useState("");
  const [supplierBusinessItem, setSupplierBusinessItem] = useState("");
  const [buyerBusinessType, setBuyerBusinessType] = useState("");
  const [buyerBusinessItem, setBuyerBusinessItem] = useState("");
  const [note, setNote] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const [showPreview, setShowPreview] = useState(false);
  const [isKakaoInApp, setIsKakaoInApp] = useState(false);

  const [issuances, setIssuances] = useState<TaxInvoiceIssuanceRow[] | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [correctingRowId, setCorrectingRowId] = useState<string | null>(null);
  const [modifyCode, setModifyCode] = useState<ModifyCode>(1);
  const [correcting, setCorrecting] = useState(false);
  const [filingError, setFilingError] = useState<string | null>(null);

  async function refreshIssuances() {
    const result = await listTaxInvoiceIssuancesAction(orderId);
    if (result.success && result.data) {
      setIssuances(result.data);
    }
  }

  useEffect(() => {
    if (open && issuances === null) {
      refreshIssuances();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleIssue() {
    if (
      !window.confirm(
        "국세청에 실제로 접수되는 계산서를 발행합니다. 이후에는 취소가 아니라 정정신고로만 바로잡을 수 있습니다. 계속할까요?"
      )
    ) {
      return;
    }

    setIssuing(true);
    setFilingError(null);

    const result = await issueTaxInvoiceAction(orderId);

    setIssuing(false);

    if (!result.success) {
      setFilingError(result.error ?? "발행에 실패했습니다.");
      return;
    }

    await refreshIssuances();
  }

  async function handleCorrect(originalIssuanceId: string) {
    if (
      !window.confirm(
        `"${MODIFY_CODE_LABELS[modifyCode]}" 사유로 정정신고합니다. 원본과 연결된 새 계산서가 국세청에 접수됩니다. 계속할까요?`
      )
    ) {
      return;
    }

    setCorrecting(true);
    setFilingError(null);

    const result = await issueTaxInvoiceCorrectionAction(orderId, originalIssuanceId, modifyCode);

    setCorrecting(false);

    if (!result.success) {
      setFilingError(result.error ?? "정정신고에 실패했습니다.");
      return;
    }

    setCorrectingRowId(null);
    await refreshIssuances();
  }

  useEffect(() => {
    setIsKakaoInApp(isKakaoInAppBrowser(window.navigator.userAgent));
  }, []);

  const query = useMemo(
    () =>
      new URLSearchParams({
        issueDate,
        supplierBusinessType,
        supplierBusinessItem,
        buyerBusinessType,
        buyerBusinessItem,
        note,
      }),
    [issueDate, supplierBusinessType, supplierBusinessItem, buyerBusinessType, buyerBusinessItem, note]
  );

  const href = useMemo(() => `${baseHref}?${query.toString()}`, [baseHref, query]);

  const externalHref = useMemo(
    () => `${externalOpenBaseHref ?? baseHref}?${query.toString()}`,
    [externalOpenBaseHref, baseHref, query]
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          fontSize: "12px",
          fontWeight: 700,
          color: "#7c2d12",
          border: "1px solid #fed7aa",
          backgroundColor: "#fff7ed",
          borderRadius: "6px",
          padding: "6px 10px",
          cursor: "pointer",
        }}
      >
        🧾 계산서(면세) 작성 도우미 {open ? "닫기 ▲" : "열기 ▼"}
      </button>

      {open && (
        <div
          style={{
            marginTop: "10px",
            border: "1px solid #fed7aa",
            borderRadius: "8px",
            padding: "14px",
            backgroundColor: "#fffbeb",
          }}
        >
          <p style={{ fontSize: "11px", color: "#92400e", lineHeight: 1.6, marginBottom: "12px" }}>
            국세청에 정식 발행되는 문서가 아닙니다. 아래 내용을 확인·수정한 뒤 PDF로 내보내
            홈택스 등에 직접 입력하는 용도의 작성 초안입니다.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
            <div>
              <label style={labelStyle}>작성연월일</label>
              <input
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                style={fieldStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>공급자 업태</label>
              <input
                type="text"
                value={supplierBusinessType}
                onChange={(e) => setSupplierBusinessType(e.target.value)}
                placeholder="예: 도매 및 소매업"
                style={fieldStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>공급자 종목</label>
              <input
                type="text"
                value={supplierBusinessItem}
                onChange={(e) => setSupplierBusinessItem(e.target.value)}
                placeholder="예: 축산물"
                style={fieldStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>공급받는자 업태</label>
              <input
                type="text"
                value={buyerBusinessType}
                onChange={(e) => setBuyerBusinessType(e.target.value)}
                style={fieldStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>공급받는자 종목</label>
              <input
                type="text"
                value={buyerBusinessItem}
                onChange={(e) => setBuyerBusinessItem(e.target.value)}
                style={fieldStyle}
              />
            </div>
          </div>

          <div style={{ marginTop: "10px" }}>
            <label style={labelStyle}>비고</label>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} style={fieldStyle} />
          </div>

          <div
            style={{
              marginTop: "14px",
              paddingTop: "12px",
              borderTop: "1px dashed #fdba74",
            }}
          >
            <p style={{ fontSize: "11px", fontWeight: 700, color: "#7c2d12", marginBottom: "6px" }}>
              국세청 실제 발행 (팝빌 연동)
            </p>

            {filingError && (
              <p style={{ fontSize: "11px", color: "#b91c1c", marginBottom: "6px" }}>{filingError}</p>
            )}

            {(issuances ?? []).map((row) => (
              <div
                key={row.id}
                style={{
                  fontSize: "11px",
                  color: "#57534e",
                  padding: "6px 8px",
                  marginBottom: "4px",
                  backgroundColor: "#ffffff",
                  border: "1px solid #fed7aa",
                  borderRadius: "6px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>
                    {row.modify_code ? `정정발행 (${MODIFY_CODE_LABELS[row.modify_code]})` : "최초발행"} ·{" "}
                    {row.status === "issued" && "✅ 발행완료"}
                    {row.status === "pending" && "⏳ 처리중"}
                    {row.status === "failed" && "❌ 실패"}
                    {row.status === "cancelled" && "취소됨"}
                  </span>
                  {row.status === "issued" && correctingRowId !== row.id && (
                    <button
                      type="button"
                      onClick={() => setCorrectingRowId(row.id)}
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        color: "#7c2d12",
                        border: "1px solid #fed7aa",
                        borderRadius: "4px",
                        padding: "3px 8px",
                        backgroundColor: "#fff7ed",
                        cursor: "pointer",
                      }}
                    >
                      정정신고
                    </button>
                  )}
                </div>

                {row.status === "failed" && row.error_message && (
                  <p style={{ marginTop: "4px", color: "#b91c1c" }}>{row.error_message}</p>
                )}

                {correctingRowId === row.id && (
                  <div style={{ marginTop: "6px", display: "flex", gap: "6px", alignItems: "center" }}>
                    <select
                      value={modifyCode}
                      onChange={(e) => setModifyCode(Number(e.target.value) as ModifyCode)}
                      style={{ ...fieldStyle, padding: "4px 6px", fontSize: "11px" }}
                    >
                      {(Object.entries(MODIFY_CODE_LABELS) as [string, string][]).map(([code, label]) => (
                        <option key={code} value={code}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={correcting}
                      onClick={() => handleCorrect(row.id)}
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        color: "#ffffff",
                        backgroundColor: "#7c2d12",
                        border: "none",
                        borderRadius: "4px",
                        padding: "4px 8px",
                        cursor: correcting ? "default" : "pointer",
                        opacity: correcting ? 0.6 : 1,
                      }}
                    >
                      {correcting ? "제출 중…" : "정정 제출"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCorrectingRowId(null)}
                      style={{
                        fontSize: "10px",
                        color: "#57534e",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      취소
                    </button>
                  </div>
                )}
              </div>
            ))}

            <button
              type="button"
              disabled={issuing}
              onClick={handleIssue}
              style={{
                fontSize: "12px",
                fontWeight: 700,
                color: "#ffffff",
                backgroundColor: "#b91c1c",
                border: "none",
                borderRadius: "6px",
                padding: "8px 14px",
                cursor: issuing ? "default" : "pointer",
                opacity: issuing ? 0.6 : 1,
              }}
            >
              {issuing ? "발행 중…" : "🚨 국세청에 실제 발행"}
            </button>
          </div>

          <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
            <button
              type="button"
              onClick={() => {
                setShowPreview(true);
                setPreviewKey((key) => key + 1);
              }}
              style={{
                fontSize: "12px",
                fontWeight: 700,
                color: "#ffffff",
                backgroundColor: "#7c2d12",
                border: "none",
                borderRadius: "6px",
                padding: "8px 14px",
                cursor: "pointer",
              }}
            >
              미리보기 갱신
            </button>
            {showPreview && !isKakaoInApp && (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#7c2d12",
                  border: "1px solid #fed7aa",
                  borderRadius: "6px",
                  padding: "8px 14px",
                  textDecoration: "none",
                  backgroundColor: "#ffffff",
                }}
              >
                새 탭에서 열기 ↗
              </a>
            )}
          </div>

          {showPreview && (
            <div
              style={{
                marginTop: "12px",
                border: "1px solid #fed7aa",
                borderRadius: "8px",
                overflow: "hidden",
                backgroundColor: "#ffffff",
              }}
            >
              {isKakaoInApp ? (
                <div style={{ padding: "20px 16px", textAlign: "center" }}>
                  <p style={{ fontSize: "12px", color: "#92400e", lineHeight: 1.7, marginBottom: "14px" }}>
                    카카오톡 브라우저에서는 PDF를 바로 볼 수 없습니다.
                    <br />
                    아래 버튼으로 기본 브라우저에서 열어주세요.
                  </p>
                  <a
                    href={buildKakaoExternalOpenUrl(new URL(externalHref, window.location.origin).toString())}
                    style={{
                      display: "inline-block",
                      backgroundColor: "#7c2d12",
                      color: "#ffffff",
                      fontSize: "13px",
                      fontWeight: 700,
                      padding: "10px 20px",
                      borderRadius: "8px",
                      textDecoration: "none",
                    }}
                  >
                    외부 브라우저에서 열기 ↗
                  </a>
                </div>
              ) : (
                <iframe
                  key={previewKey}
                  src={href}
                  title="계산서 작성 초안 미리보기"
                  style={{ width: "100%", height: "70vh", minHeight: "420px", border: "none", display: "block" }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
