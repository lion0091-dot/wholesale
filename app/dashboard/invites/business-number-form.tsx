"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { submitSupplierBusinessNumberAction } from "@/app/actions/supplier-auth";
import { formatBusinessNumber } from "@/lib/validation/business-number";

interface BusinessNumberFormProps {
  /** 이미 제출된 번호 (없으면 미제출 상태) */
  currentBusinessNumber?: string | null;
  /** 이미 제출된 개업일자 (없으면 미제출 상태) — YYYY-MM-DD */
  currentBusinessStartDate?: string | null;
}

/**
 * 승인 심사용 사업자등록번호 제출 폼.
 *
 * 가입은 번호 없이도 완료되지만, 행정 승인(= 초대장 발부 활성화)에는 번호가 필요하다.
 * 승인 완료 후에는 업체 동일성이 흔들리면 안 되므로 DB 함수가 재제출을 막는다.
 */
export function BusinessNumberForm({
  currentBusinessNumber,
  currentBusinessStartDate,
}: BusinessNumberFormProps) {
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
      const result = await submitSupplierBusinessNumberAction(formData);

      if (!result.success) {
        setError(result.error ?? "사업자등록번호 제출에 실패했습니다.");
        return;
      }

      setSaved(true);
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label
        htmlFor="business_number"
        style={{
          display: "block",
          fontSize: "13px",
          fontWeight: 600,
          color: "#334155",
          marginBottom: "6px",
        }}
      >
        사업자등록번호 {currentBusinessNumber ? "(제출 완료 — 수정 가능)" : "(미제출)"}
      </label>
      <p style={{ fontSize: "12px", color: "#64748b", marginBottom: "8px", lineHeight: 1.5 }}>
        국세청 진위확인을 위해 개업일자도 함께 제출해야 합니다.
      </p>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input
          id="business_number"
          name="business_number"
          type="text"
          inputMode="numeric"
          required
          maxLength={12}
          defaultValue={formatBusinessNumber(currentBusinessNumber)}
          placeholder="1234567890 (숫자 10자리)"
          disabled={pending}
          style={{
            flex: "1 1 200px",
            padding: "10px 12px",
            fontSize: "15px",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            backgroundColor: "#ffffff",
            color: "#0f172a",
          }}
        />
        <input
          id="business_start_date"
          name="business_start_date"
          type="date"
          required
          max={new Date().toISOString().slice(0, 10)}
          defaultValue={currentBusinessStartDate ?? ""}
          disabled={pending}
          aria-label="개업일자"
          style={{
            flex: "1 1 160px",
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
          {pending ? "제출 중..." : "심사 요청"}
        </button>
      </div>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", marginTop: "8px", lineHeight: 1.6 }}>
          {error}
        </p>
      )}

      {saved && !error && (
        <p style={{ fontSize: "12px", color: "#166534", marginTop: "8px", lineHeight: 1.6 }}>
          ✓ 제출되었습니다. 플랫폼 운영팀이 사업자등록증을 대조한 뒤 승인 결과를 알림톡으로
          안내합니다.
        </p>
      )}
    </form>
  );
}
