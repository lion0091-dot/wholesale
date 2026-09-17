"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { submitSupplierBusinessLicenseAction } from "@/app/actions/supplier-auth";

interface BusinessLicenseFormProps {
  /** 마지막 업로드 시각 — 없으면 미제출 상태 */
  currentUploadedAt?: string | null;
}

function formatUploadedAt(value: string): string {
  return new Date(value).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 사업자등록증 사본 업로드 폼.
 *
 * 승인 심사 시 관리자가 사본과 사업자등록번호를 대조할 수 있도록 이미지/PDF를
 * 받는다. 재업로드하면 이전 파일을 덮어쓴다(같은 경로로 upsert).
 */
export function BusinessLicenseForm({ currentUploadedAt }: BusinessLicenseFormProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await submitSupplierBusinessLicenseAction(formData);

      if (!result.success) {
        setError(result.error ?? "사업자등록증 업로드에 실패했습니다.");
        return;
      }

      setSaved(true);
      formRef.current?.reset();
      router.refresh();
    });
  };

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate style={{ marginTop: "16px" }}>
      <label
        htmlFor="business_license"
        style={{
          display: "block",
          fontSize: "13px",
          fontWeight: 600,
          color: "#334155",
          marginBottom: "6px",
        }}
      >
        사업자등록증 사본{" "}
        {currentUploadedAt
          ? `(제출 완료 — ${formatUploadedAt(currentUploadedAt)}, 재업로드하면 교체됩니다)`
          : "(미제출)"}
      </label>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input
          id="business_license"
          name="business_license"
          type="file"
          accept="image/png,image/jpeg,application/pdf"
          required
          disabled={pending}
          style={{
            flex: "1 1 220px",
            fontSize: "13px",
            padding: "8px",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            backgroundColor: "#ffffff",
          }}
        />
        <button
          type="submit"
          disabled={pending}
          style={{
            padding: "10px 16px",
            fontSize: "14px",
            fontWeight: 700,
            color: "#ffffff",
            backgroundColor: pending ? "#94a3b8" : "#0f172a",
            border: "none",
            borderRadius: "8px",
            cursor: pending ? "wait" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {pending ? "업로드 중..." : "업로드"}
        </button>
      </div>

      <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "6px" }}>
        JPG, PNG, PDF · 최대 8MB
      </p>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", marginTop: "8px", lineHeight: 1.6 }}>
          {error}
        </p>
      )}

      {saved && !error && (
        <p style={{ fontSize: "12px", color: "#166534", marginTop: "8px", lineHeight: 1.6 }}>
          ✓ 업로드되었습니다.
        </p>
      )}
    </form>
  );
}
