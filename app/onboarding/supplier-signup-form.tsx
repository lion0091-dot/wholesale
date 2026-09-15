"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { completeSupplierSignupAction } from "@/app/actions/supplier-auth";

interface SupplierSignupFormProps {
  /** 카카오 프로필에서 받아온 기본값 */
  defaultName?: string | null;
  defaultPhone?: string | null;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  fontSize: "15px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "13px",
  fontWeight: 600,
  color: "#334155",
  marginBottom: "6px",
};

const hintStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#94a3b8",
  marginTop: "5px",
  lineHeight: 1.6,
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "8px",
  fontSize: "13px",
  color: "#334155",
  lineHeight: 1.6,
  padding: "7px 0",
};

/**
 * 공급사 최소 정보 입력 (온보딩 1단계).
 *
 * 카카오 로그인으로 계정은 이미 만들어졌고, 여기서 받는 것은
 * 필수 약관 동의 + 연락처 + 상호뿐이다. 제출 즉시 미니샵 토큰과 조직 스코프가
 * 생성되어 상품 등록·발주 관리를 바로 시작할 수 있다.
 * (사업자등록번호는 선택 — 승인 심사 단계에서 받아도 된다)
 */
export function SupplierSignupForm({ defaultName, defaultPhone }: SupplierSignupFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [agreements, setAgreements] = useState({
    terms: false,
    privacy: false,
    marketing: false,
  });
  const [pending, startTransition] = useTransition();

  const agreeAll = agreements.terms && agreements.privacy && agreements.marketing;

  const toggleAgreement = (key: keyof typeof agreements, checked: boolean) => {
    setAgreements((previous) => ({ ...previous, [key]: checked }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);

    startTransition(async () => {
      const result = await completeSupplierSignupAction(formData);

      if (!result.success) {
        setError(result.error ?? "가입 처리에 실패했습니다.");
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    });
  };

  return (
    <form id="supplier-signup-form" onSubmit={handleSubmit} noValidate>
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
            marginBottom: "14px",
            lineHeight: 1.6,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ marginBottom: "14px" }}>
        <label htmlFor="business_name" style={labelStyle}>
          상호(업체명) <span style={{ color: "#dc2626" }}>*</span>
        </label>
        <input
          id="business_name"
          name="business_name"
          type="text"
          required
          maxLength={60}
          placeholder="예) 마장동 태양축산"
          disabled={pending}
          style={inputStyle}
        />
        <p style={hintStyle}>바이어에게 표시되는 이름입니다. 나중에 수정할 수 있습니다.</p>
      </div>

      <div style={{ marginBottom: "14px" }}>
        <label htmlFor="representative_name" style={labelStyle}>
          담당자(대표자) 성명 <span style={{ color: "#dc2626" }}>*</span>
        </label>
        <input
          id="representative_name"
          name="representative_name"
          type="text"
          required
          maxLength={30}
          defaultValue={defaultName ?? ""}
          placeholder="예) 김태양"
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: "14px" }}>
        <label htmlFor="phone" style={labelStyle}>
          연락처 <span style={{ color: "#dc2626" }}>*</span>
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          required
          maxLength={14}
          defaultValue={defaultPhone ?? ""}
          placeholder="01012345678"
          disabled={pending}
          style={inputStyle}
        />
        <p style={hintStyle}>발주 접수 알림과 승인 결과 안내를 받을 번호입니다.</p>
      </div>

      <div style={{ marginBottom: "14px" }}>
        <label htmlFor="business_address" style={labelStyle}>
          사업장 주소 <span style={{ color: "#dc2626" }}>*</span>
        </label>
        <input
          id="business_address"
          name="business_address"
          type="text"
          required
          minLength={5}
          maxLength={200}
          placeholder="예) 서울 성동구 마장로 123, 2층"
          disabled={pending}
          style={inputStyle}
        />
        <p style={hintStyle}>거래명세서 PDF의 공급자란에 표시됩니다. 나중에 초대장 메뉴에서 수정할 수 있습니다.</p>
      </div>

      <div style={{ marginBottom: "18px" }}>
        <label htmlFor="business_number" style={labelStyle}>
          사업자등록번호 <span style={{ color: "#64748b", fontWeight: 500 }}>(선택)</span>
        </label>
        <input
          id="business_number"
          name="business_number"
          type="text"
          inputMode="numeric"
          maxLength={12}
          placeholder="1234567890 (숫자 10자리)"
          disabled={pending}
          style={inputStyle}
        />
        <p style={hintStyle}>
          지금 입력하면 승인 심사가 바로 시작됩니다. 나중에 초대장 메뉴에서 등록해도 됩니다.
        </p>
      </div>

      <div
        style={{
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "10px 14px",
          marginBottom: "18px",
          backgroundColor: "#f8fafc",
        }}
      >
        <label style={{ ...checkboxRowStyle, fontWeight: 700, color: "#0f172a" }}>
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
            disabled={pending}
            style={{ marginTop: "3px" }}
          />
          <span>전체 동의</span>
        </label>

        <div style={{ borderTop: "1px solid #e2e8f0", marginTop: "4px", paddingTop: "4px" }}>
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              name="agree_terms"
              checked={agreements.terms}
              onChange={(event) => toggleAgreement("terms", event.target.checked)}
              required
              disabled={pending}
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

          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              name="agree_privacy"
              checked={agreements.privacy}
              onChange={(event) => toggleAgreement("privacy", event.target.checked)}
              required
              disabled={pending}
              style={{ marginTop: "3px" }}
            />
            <span>
              <strong style={{ color: "#dc2626" }}>[필수]</strong>{" "}
              <Link
                href="/privacy"
                target="_blank"
                style={{ color: "#2563eb", textDecoration: "underline" }}
              >
                개인정보 수집·이용
              </Link>
              에 동의합니다. (상호·담당자명·연락처)
            </span>
          </label>

          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              name="agree_marketing"
              checked={agreements.marketing}
              onChange={(event) => toggleAgreement("marketing", event.target.checked)}
              disabled={pending}
              style={{ marginTop: "3px" }}
            />
            <span>
              <span style={{ color: "#64748b" }}>[선택]</span> 마케팅 정보 및 알림톡 수신에
              동의합니다.
            </span>
          </label>
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        style={{
          width: "100%",
          padding: "13px",
          fontSize: "15px",
          fontWeight: 800,
          color: "#ffffff",
          backgroundColor: pending ? "#f87171" : "#dc2626",
          border: "none",
          borderRadius: "10px",
          cursor: pending ? "wait" : "pointer",
        }}
      >
        {pending ? "가입 처리 중..." : "동의하고 바로 시작하기"}
      </button>

      <p style={{ ...hintStyle, textAlign: "center", marginTop: "12px" }}>
        제출 즉시 상품 등록과 발주 관리를 사용할 수 있습니다. 초대장 발부는 행정 승인 후
        활성화됩니다.
      </p>
    </form>
  );
}
