"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { submitSupplierRepresentativeNameAction } from "@/app/actions/supplier-auth";

interface RepresentativeNameFormProps {
  /** 이미 등록된 대표자 성명 (없으면 미등록 상태 — 국세청 진위확인이 불가능) */
  currentRepresentativeName?: string | null;
}

/**
 * 국세청 진위확인용 대표자(담당자) 성명 등록/수정 폼.
 *
 * business_address와 같은 이유로 승인 심사와 무관하게 언제든 등록/수정할 수 있다.
 * 사업자등록증에 인쇄된 이름과 정확히 일치해야 진위확인이 "일치"로 나온다.
 */
export function RepresentativeNameForm({ currentRepresentativeName }: RepresentativeNameFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await submitSupplierRepresentativeNameAction(formData);

      if (!result.success) {
        setError(result.error ?? "대표자 성명 저장에 실패했습니다.");
        return;
      }

      setSaved(true);
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} noValidate style={{ marginBottom: "16px" }}>
      <label
        htmlFor="representative_name"
        style={{
          display: "block",
          fontSize: "13px",
          fontWeight: 600,
          color: "#334155",
          marginBottom: "6px",
        }}
      >
        대표자(담당자) 성명 <span style={{ color: "#dc2626" }}>*</span>{" "}
        {currentRepresentativeName ? "(등록 완료 — 수정 가능)" : "(미등록 — 진위확인 불가)"}
      </label>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input
          id="representative_name"
          name="representative_name"
          type="text"
          required
          minLength={2}
          maxLength={30}
          defaultValue={currentRepresentativeName ?? ""}
          placeholder="예) 김태양 (사업자등록증에 인쇄된 대표자명)"
          disabled={pending}
          style={{
            flex: "1 1 260px",
            padding: "10px 12px",
            fontSize: "15px",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            backgroundColor: "#ffffff",
            color: "#0f172a",
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
          {pending ? "저장 중..." : "저장"}
        </button>
      </div>

      <p style={{ fontSize: "12px", color: "#94a3b8", marginTop: "8px", lineHeight: 1.6 }}>
        국세청 진위확인 대조에 쓰이는 이름입니다. 사업자등록증에 인쇄된 대표자명과 한 글자도
        다르지 않게 입력해주세요(공동대표는 &quot;외 1명&quot; 없이 대표자 1인 성명만).
      </p>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", marginTop: "8px", lineHeight: 1.6 }}>
          {error}
        </p>
      )}

      {saved && !error && (
        <p style={{ fontSize: "12px", color: "#166534", marginTop: "8px", lineHeight: 1.6 }}>
          ✓ 저장되었습니다.
        </p>
      )}
    </form>
  );
}
