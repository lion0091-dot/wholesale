"use client";

import { useEffect, useState } from "react";
import { buildKakaoExternalOpenUrl, isKakaoInAppBrowser } from "@/lib/kakao-in-app";

interface StatementPreviewButtonProps {
  /** PDF(또는 발행 불가 시 경고 HTML)를 돌려주는 라우트 — /dashboard/orders/[id]/statement 등 */
  href: string;
  /** 버튼 라벨 앞에 붙는 텍스트 */
  label?: string;
}

/**
 * 거래명세서를 새 탭 대신 페이지 안에서 바로 보여주는 인앱 미리보기.
 *
 * 클릭 전엔 iframe 자체를 렌더링하지 않는다 — 열 때마다 서버가 PDF를 새로
 * 생성하므로(app/dashboard/orders/[id]/statement/route.ts 등 참고), 안 열어본
 * 사람의 페이지 로드 때마다 불필요하게 PDF를 만들지 않기 위함이다.
 * 주소 미등록 등으로 발행이 막힌 경우 라우트가 돌려주는 경고 HTML도 그대로
 * iframe 안에 나타난다 — 별도 에러 처리가 필요 없다.
 *
 * 카카오톡 인앱 브라우저는 예외다 — 자체 웹뷰 제약으로 PDF 미리보기는 백지로,
 * 다운로드는 "페이지가 작동하지 않습니다" 오류로 나타난다. 이 환경에서는 iframe
 * 대신 기본 브라우저로 넘기는 버튼만 보여준다.
 */
export function StatementPreviewButton({ href, label = "거래명세서" }: StatementPreviewButtonProps) {
  const [open, setOpen] = useState(false);
  const [isKakaoInApp, setIsKakaoInApp] = useState(false);

  useEffect(() => {
    setIsKakaoInApp(isKakaoInAppBrowser(window.navigator.userAgent));
  }, []);

  const externalOpenUrl = isKakaoInApp
    ? buildKakaoExternalOpenUrl(new URL(href, window.location.origin).toString())
    : null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          fontSize: "12px",
          fontWeight: 700,
          color: "#2563eb",
          border: "1px solid #bfdbfe",
          backgroundColor: "#eff6ff",
          borderRadius: "6px",
          padding: "6px 10px",
          cursor: "pointer",
        }}
      >
        📄 {label} {open ? "미리보기 닫기 ▲" : "미리보기 ▼"}
      </button>

      {open && (
        <div
          style={{
            marginTop: "10px",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            overflow: "hidden",
            backgroundColor: "#f8fafc",
          }}
        >
          {isKakaoInApp ? (
            <div style={{ padding: "20px 16px", textAlign: "center" }}>
              <p style={{ fontSize: "12px", color: "#92400e", lineHeight: 1.7, marginBottom: "14px" }}>
                카카오톡 브라우저에서는 PDF를 바로 보거나 저장할 수 없습니다.
                <br />
                아래 버튼으로 기본 브라우저에서 열어주세요.
              </p>
              <a
                href={externalOpenUrl ?? href}
                style={{
                  display: "inline-block",
                  backgroundColor: "#0f172a",
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
            <>
              <iframe
                src={href}
                title={label}
                style={{ width: "100%", height: "70vh", minHeight: "420px", border: "none", display: "block" }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "14px",
                  padding: "6px 10px",
                  borderTop: "1px solid #e2e8f0",
                  backgroundColor: "#ffffff",
                }}
              >
                <a
                  href={`${href}?download=1`}
                  style={{ fontSize: "11px", color: "#2563eb", fontWeight: 600, textDecoration: "none" }}
                >
                  PDF 다운로드 ⬇
                </a>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "11px", color: "#64748b", textDecoration: "none" }}
                >
                  새 탭에서 열기 ↗
                </a>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
