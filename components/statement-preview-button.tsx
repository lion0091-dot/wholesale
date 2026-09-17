"use client";

import { useState } from "react";

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
 */
export function StatementPreviewButton({ href, label = "거래명세서" }: StatementPreviewButtonProps) {
  const [open, setOpen] = useState(false);

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
        </div>
      )}
    </div>
  );
}
