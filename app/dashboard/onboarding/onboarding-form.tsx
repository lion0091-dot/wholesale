"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { createOrganization } from "@/app/actions/organization";
import { linkDevDefaultOrganization } from "./actions";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  fontSize: "15px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "13px",
  fontWeight: 600,
  color: "#334155",
  marginBottom: "6px",
};

const alertStyle = (tone: "error" | "success" | "info"): React.CSSProperties => {
  const palette = {
    error: { backgroundColor: "#fee2e2", border: "1px solid #fecaca", color: "#991b1b" },
    success: { backgroundColor: "#dcfce7", border: "1px solid #bbf7d0", color: "#166534" },
    info: { backgroundColor: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af" },
  }[tone];

  return {
    ...palette,
    fontSize: "13px",
    padding: "10px 12px",
    borderRadius: "8px",
    marginBottom: "14px",
    lineHeight: 1.6,
  };
};

/** 조직(공급사) 생성 폼 — 생성자는 자동으로 owner로 등록된다. */
export function OrganizationCreateForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);

    startTransition(async () => {
      const result = await createOrganization(formData);

      if (!result.success) {
        setError(result.error ?? "조직 생성에 실패했습니다.");
        return;
      }

      router.replace("/dashboard/products");
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      {error && (
        <div role="alert" style={alertStyle("error")}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: "14px" }}>
        <label htmlFor="name" style={labelStyle}>
          조직(업체)명
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          minLength={2}
          placeholder="예: 마장동 태양축산"
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: "14px" }}>
        <label htmlFor="business_number" style={labelStyle}>
          사업자등록번호 (숫자 10자리)
        </label>
        <input
          id="business_number"
          name="business_number"
          type="text"
          required
          inputMode="numeric"
          placeholder="000-00-00000"
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: "14px" }}>
        <label htmlFor="representative_name" style={labelStyle}>
          대표자명 (선택)
        </label>
        <input
          id="representative_name"
          name="representative_name"
          type="text"
          placeholder="예: 홍길동"
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: "18px" }}>
        <label htmlFor="subscription_tier" style={labelStyle}>
          구독 플랜
        </label>
        <select
          id="subscription_tier"
          name="subscription_tier"
          defaultValue="pro"
          disabled={pending}
          style={inputStyle}
        >
          <option value="lite">Lite</option>
          <option value="pro">Pro</option>
          <option value="enterprise">Enterprise</option>
        </select>
      </div>

      <button
        type="submit"
        disabled={pending}
        style={{
          width: "100%",
          padding: "12px",
          fontSize: "15px",
          fontWeight: 700,
          color: "#ffffff",
          backgroundColor: pending ? "#f87171" : "#dc2626",
          border: "none",
          borderRadius: "8px",
          cursor: pending ? "wait" : "pointer",
        }}
      >
        {pending ? "조직 생성 중..." : "조직 생성하고 백오피스 시작"}
      </button>
    </form>
  );
}

/** 개발/테스트 환경에서만 노출되는 기본 조직 자동 연결 버튼 */
export function DevOrgLinkPanel() {
  const router = useRouter();
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const handleClick = () => {
    setMessage(null);

    startTransition(async () => {
      const result = await linkDevDefaultOrganization();

      if (result.status === "linked" || result.status === "already-linked") {
        setMessage({ tone: "success", text: "기본 테스트 조직에 연결되었습니다. 이동합니다..." });
        router.replace("/dashboard/products");
        router.refresh();
        return;
      }

      setMessage({
        tone: "error",
        text: result.reason ?? "기본 테스트 조직 연결에 실패했습니다.",
      });
    });
  };

  return (
    <div>
      {message && (
        <div role="alert" style={alertStyle(message.tone === "error" ? "error" : "success")}>
          {message.text}
        </div>
      )}

      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        style={{
          width: "100%",
          padding: "11px",
          fontSize: "14px",
          fontWeight: 700,
          color: "#1e40af",
          backgroundColor: "#ffffff",
          border: "1px solid #bfdbfe",
          borderRadius: "8px",
          cursor: pending ? "wait" : "pointer",
        }}
      >
        {pending ? "연결 중..." : "기본 테스트 조직(Default Organization)에 연결"}
      </button>
    </div>
  );
}
