"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import { recordBuyerConsentAction } from "@/app/actions/buyer-auth";
import { SHOP_MAX_WIDTH } from "./shop-chrome";

interface BuyerConsentGateProps {
  shopToken: string;
  /** 인사말에 쓸 표시 이름 (카카오 닉네임, 세션에서만 읽은 값) */
  displayName: string;
}

/**
 * 바이어 이용약관/개인정보 수집·이용 동의 화면.
 *
 * 카카오 로그인은 이미 끝났지만(claim_shop_access 완료) 이 서비스 자체의
 * 약관·개인정보 동의는 아직 받지 않은 상태(profiles.terms_agreed_at IS NULL)에서
 * 카탈로그 대신 이 화면이 먼저 뜬다. 제출해야 다음부터 카탈로그로 바로 진입한다.
 */
export function BuyerConsentGate({ shopToken, displayName }: BuyerConsentGateProps) {
  const [error, setError] = useState<string | null>(null);
  const [agreements, setAgreements] = useState({
    terms: false,
    privacy: false,
    marketing: false,
  });
  const [isPending, startTransition] = useTransition();

  const agreeAll = agreements.terms && agreements.privacy && agreements.marketing;
  const canSubmit = agreements.terms && agreements.privacy;

  const toggleAgreement = (key: keyof typeof agreements, checked: boolean) => {
    setAgreements((previous) => ({ ...previous, [key]: checked }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await recordBuyerConsentAction(shopToken, formData);

      if (!result.success) {
        setError(result.error ?? "동의 처리에 실패했습니다.");
        return;
      }

      // 서버 컴포넌트(page.tsx)가 terms_agreed_at을 다시 읽어 카탈로그로 넘어간다.
      window.location.reload();
    });
  };

  return (
    <main
      style={{
        maxWidth: SHOP_MAX_WIDTH,
        margin: "0 auto",
        minHeight: "100vh",
        backgroundColor: "#f8fafc",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "24px 20px",
        boxSizing: "border-box",
      }}
    >
      <form
        onSubmit={handleSubmit}
        noValidate
        style={{
          backgroundColor: "#ffffff",
          borderRadius: "16px",
          border: "1px solid #e2e8f0",
          padding: "32px 24px",
        }}
      >
        <div style={{ fontSize: "36px", marginBottom: "14px", textAlign: "center" }}>🥩</div>

        <h1
          style={{
            fontSize: "19px",
            fontWeight: 800,
            color: "#0f172a",
            marginBottom: "8px",
            textAlign: "center",
          }}
        >
          {displayName} 님, 거의 다 됐어요
        </h1>

        <p
          style={{
            fontSize: "13px",
            color: "#475569",
            lineHeight: 1.7,
            marginBottom: "20px",
            textAlign: "center",
          }}
        >
          발주 서비스 이용을 위해 아래 동의가 필요합니다.
        </p>

        {error && (
          <div
            role="alert"
            style={{
              backgroundColor: "#fee2e2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              fontSize: "13px",
              padding: "10px 12px",
              borderRadius: "8px",
              marginBottom: "16px",
              lineHeight: 1.6,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "10px 14px",
            marginBottom: "20px",
            backgroundColor: "#f8fafc",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              fontSize: "13px",
              fontWeight: 700,
              color: "#0f172a",
              padding: "7px 0",
            }}
          >
            <input
              type="checkbox"
              checked={agreeAll}
              onChange={(event) =>
                setAgreements({
                  terms: event.target.checked,
                  privacy: event.target.checked,
                  marketing: event.target.checked,
                })
              }
              disabled={isPending}
              style={{ marginTop: "3px" }}
            />
            <span>전체 동의</span>
          </label>

          <div style={{ borderTop: "1px solid #e2e8f0", marginTop: "4px", paddingTop: "4px" }}>
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                fontSize: "13px",
                color: "#334155",
                lineHeight: 1.6,
                padding: "7px 0",
              }}
            >
              <input
                type="checkbox"
                name="agree_terms"
                checked={agreements.terms}
                onChange={(event) => toggleAgreement("terms", event.target.checked)}
                required
                disabled={isPending}
                style={{ marginTop: "3px" }}
              />
              <span>
                <strong style={{ color: "#dc2626" }}>[필수]</strong>{" "}
                <Link href="/terms" target="_blank" style={{ color: "#2563eb", textDecoration: "underline" }}>
                  서비스 이용약관
                </Link>
                에 동의합니다.
              </span>
            </label>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                fontSize: "13px",
                color: "#334155",
                lineHeight: 1.6,
                padding: "7px 0",
              }}
            >
              <input
                type="checkbox"
                name="agree_privacy"
                checked={agreements.privacy}
                onChange={(event) => toggleAgreement("privacy", event.target.checked)}
                required
                disabled={isPending}
                style={{ marginTop: "3px" }}
              />
              <span>
                <strong style={{ color: "#dc2626" }}>[필수]</strong>{" "}
                <Link href="/privacy" target="_blank" style={{ color: "#2563eb", textDecoration: "underline" }}>
                  개인정보 수집·이용
                </Link>
                에 동의합니다. (발주 처리를 위한 상호·연락처·배송지)
              </span>
            </label>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                fontSize: "13px",
                color: "#334155",
                lineHeight: 1.6,
                padding: "7px 0",
              }}
            >
              <input
                type="checkbox"
                name="agree_marketing"
                checked={agreements.marketing}
                onChange={(event) => toggleAgreement("marketing", event.target.checked)}
                disabled={isPending}
                style={{ marginTop: "3px" }}
              />
              <span>
                <span style={{ color: "#334155" }}>[선택]</span> 특가·신상품 알림톡 수신에
                동의합니다.
              </span>
            </label>
          </div>
        </div>

        <button
          type="submit"
          disabled={isPending || !canSubmit}
          style={{
            width: "100%",
            backgroundColor: isPending || !canSubmit ? "#fca5a5" : "#dc2626",
            color: "#ffffff",
            fontWeight: 800,
            fontSize: "15px",
            padding: "15px",
            borderRadius: "10px",
            border: "none",
            cursor: isPending || !canSubmit ? "not-allowed" : "pointer",
          }}
        >
          {isPending ? "처리 중..." : "동의하고 시작하기"}
        </button>
      </form>
    </main>
  );
}
