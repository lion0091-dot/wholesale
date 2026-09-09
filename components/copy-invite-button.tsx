"use client";

import { useState } from "react";

interface CopyInviteButtonProps {
  shopToken: string;
  wholesalerName: string;
}

export function CopyInviteButton({ shopToken, wholesalerName }: CopyInviteButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyInvite = async () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const shopUrl = `${origin}/shop/${shopToken}`;

    const inviteText = `[단골 거래처 모바일 발주서 안내]

안녕하세요, ${wholesalerName}입니다.
바이어 사장님들의 빠르고 편리한 육류 발주를 위해 1:1 모바일 미니샵을 오픈했습니다.

아래 전용 초대 링크를 통해 당일 고기 품목과 단골 전용 마감 특가(시크릿딜)를 확인하시고 간편하게 발주서를 보내주세요!

👉 발주 링크: ${shopUrl}
(스마트폰 브라우저 메뉴에서 '홈 화면에 추가'해 두시면 매일 편리하게 주문하실 수 있습니다.)`;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(inviteText);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = inviteText;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }

      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      alert("링크 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      {/* 카카오톡 초대 링크 복사 버튼 */}
      <button
        onClick={handleCopyInvite}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          backgroundColor: copied ? "#16a34a" : "#fee500",
          color: copied ? "#ffffff" : "#181600",
          fontSize: "12px",
          fontWeight: 700,
          padding: "7px 12px",
          borderRadius: "6px",
          border: "none",
          cursor: "pointer",
          boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
          transition: "all 0.2s ease",
        }}
      >
        <span>{copied ? "✓ 복사 완료!" : "💬 카톡 초대링크 복사"}</span>
      </button>

      {/* 내 미니샵 새 탭 열기 */}
      <a
        href={`/shop/${shopToken}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: "12px",
          fontWeight: 600,
          color: "#2563eb",
          backgroundColor: "#eff6ff",
          padding: "6px 10px",
          borderRadius: "6px",
          textDecoration: "none",
          border: "1px solid #bfdbfe",
        }}
      >
        내 미니샵 바로가기 ↗
      </a>
    </div>
  );
}
