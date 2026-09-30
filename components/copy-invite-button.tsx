"use client";

import { useState, useTransition } from "react";
import { issueInviteAction } from "@/app/actions/invite";
import { normalizePhone, isValidPhone } from "@/lib/validation/phone";

interface CopyInviteButtonProps {
  /** 초대장 발부 권한 (미승인 공급사는 false) */
  canIssue: boolean;
  /** 발부가 막힌 사유 — 버튼 대신 안내로 노출한다. */
  restrictionMessage?: string | null;
  /**
   * 승인된 공급사에게만 전달되는 미니샵 토큰.
   * '내 미니샵 바로가기' 미리보기 링크에만 쓰고, 초대 문구/링크 생성은
   * 항상 서버 액션(issueInviteAction)이 담당한다.
   */
  shopToken?: string | null;
  /** 특정 바이어 전용 문구로 만들 때 상호 */
  customerName?: string | null;
}

/**
 * 초대장(카카오톡 초대 문구 + 전용 주문 링크) 복사 버튼.
 *
 * 문구와 링크는 클라이언트에서 조립하지 않는다. 승인 심사를 통과하지 않은 공급사가
 * shop_token 을 손에 넣지 못하도록, 서버 액션이 권한을 확인한 뒤에만 완성된
 * 문구를 내려준다.
 */
export function CopyInviteButton({
  canIssue,
  restrictionMessage,
  shopToken,
  customerName,
}: CopyInviteButtonProps) {
  const [phone, setPhone] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const normalizedPhone = normalizePhone(phone);
  const phoneReady = isValidPhone(normalizedPhone);

  const handleCopyInvite = () => {
    setError(null);

    if (!phoneReady) {
      setError("초대할 손님의 전화번호를 입력해주세요(숫자 9자리 이상).");
      return;
    }

    startTransition(async () => {
      const result = await issueInviteAction(customerName ?? null, normalizedPhone);

      if (!result.success || !result.data) {
        setError(result.error ?? "초대장을 생성할 수 없습니다.");
        return;
      }

      try {
        await copyText(result.data.message);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      } catch {
        setError("링크 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
      }
    });
  };

  if (!canIssue) {
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          backgroundColor: "#f1f5f9",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          padding: "8px 12px",
          fontSize: "12px",
          color: "#64748b",
          lineHeight: 1.6,
          maxWidth: "460px",
        }}
      >
        <span aria-hidden>🔒</span>
        <span>{restrictionMessage ?? "승인 완료 후 초대장 발부가 활성화됩니다."}</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <input
          type="tel"
          inputMode="numeric"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="초대할 손님 전화번호 (예: 01012345678)"
          style={{
            fontSize: "12px",
            padding: "7px 10px",
            borderRadius: "6px",
            border: "1px solid #cbd5e1",
            width: "220px",
          }}
        />

        {/* 카카오톡 초대 문구 복사 */}
        <button
          type="button"
          onClick={handleCopyInvite}
          disabled={pending}
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
            cursor: pending ? "wait" : "pointer",
            boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
            transition: "all 0.2s ease",
          }}
        >
          <span>
            {pending ? "초대장 생성 중..." : copied ? "✓ 복사 완료!" : "💬 카톡 초대링크 복사"}
          </span>
        </button>

        {/* 내 미니샵 새 탭 열기 */}
        {shopToken && (
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
        )}
      </div>

      <span style={{ fontSize: "11px", color: "#94a3b8", lineHeight: 1.5 }}>
        이 번호로 카카오 로그인해야 자동으로 단골 등록됩니다. 링크가 다른 사람에게 전달돼도
        번호가 다르면 자동승인되지 않고 승인 대기로 남습니다.
      </span>

      {error && (
        <span role="alert" style={{ fontSize: "12px", color: "#b91c1c", lineHeight: 1.6 }}>
          {error}
        </span>
      )}
    </div>
  );
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
