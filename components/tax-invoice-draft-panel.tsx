"use client";

import { useEffect, useMemo, useState } from "react";
import { buildKakaoExternalOpenUrl, isKakaoInAppBrowser } from "@/lib/kakao-in-app";

interface TaxInvoiceDraftPanelProps {
  /** PDF(또는 발행 불가 경고 HTML)를 돌려주는 라우트 — /dashboard/orders/[id]/tax-invoice */
  baseHref: string;
  /** 작성일자 입력 기본값 — 보통 발주일 */
  defaultIssueDate: string;
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
export function TaxInvoiceDraftPanel({ baseHref, defaultIssueDate }: TaxInvoiceDraftPanelProps) {
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

  useEffect(() => {
    setIsKakaoInApp(isKakaoInAppBrowser(window.navigator.userAgent));
  }, []);

  const href = useMemo(() => {
    const query = new URLSearchParams({
      issueDate,
      supplierBusinessType,
      supplierBusinessItem,
      buyerBusinessType,
      buyerBusinessItem,
      note,
    });

    return `${baseHref}?${query.toString()}`;
  }, [baseHref, issueDate, supplierBusinessType, supplierBusinessItem, buyerBusinessType, buyerBusinessItem, note]);

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
                    href={buildKakaoExternalOpenUrl(new URL(href, window.location.origin).toString())}
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
