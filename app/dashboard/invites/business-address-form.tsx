"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { submitSupplierBusinessAddressAction } from "@/app/actions/supplier-auth";

interface BusinessAddressFormProps {
  /** 이미 등록된 주소 (없으면 미등록 상태 — 거래명세서 PDF 발행이 막혀 있다) */
  currentBusinessAddress?: string | null;
}

/**
 * 거래명세서 PDF 공급자란에 쓸 사업장 주소 등록 폼.
 *
 * business_number와 달리 승인 심사와 무관하게 언제든 등록/수정할 수 있다.
 * 미등록 상태면 PDF 발행 라우트(app/dashboard/orders/[id]/statement)가
 * 조용히 '-'로 내보내지 않고 발행 자체를 막으므로, 이 폼을 필수로 안내한다.
 */
export function BusinessAddressForm({ currentBusinessAddress }: BusinessAddressFormProps) {
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
      const result = await submitSupplierBusinessAddressAction(formData);

      if (!result.success) {
        setError(result.error ?? "사업장 주소 저장에 실패했습니다.");
        return;
      }

      setSaved(true);
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label
        htmlFor="business_address"
        style={{
          display: "block",
          fontSize: "13px",
          fontWeight: 600,
          color: "#334155",
          marginBottom: "6px",
        }}
      >
        사업장 주소 <span style={{ color: "#dc2626" }}>*</span>{" "}
        {currentBusinessAddress ? "(등록 완료 — 수정 가능)" : "(미등록 — 거래명세서 발행 불가)"}
      </label>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input
          id="business_address"
          name="business_address"
          type="text"
          required
          minLength={5}
          maxLength={200}
          defaultValue={currentBusinessAddress ?? ""}
          placeholder="예) 서울 성동구 마장로 123, 2층"
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
        거래명세서 PDF의 &quot;공급자&quot; 정보에 그대로 표시됩니다. 등록 전에는 고객(소매)/공급사
        모두 해당 발주의 거래명세서를 발행할 수 없습니다.
      </p>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", marginTop: "8px", lineHeight: 1.6 }}>
          {error}
        </p>
      )}

      {saved && !error && (
        <p style={{ fontSize: "12px", color: "#166534", marginTop: "8px", lineHeight: 1.6 }}>
          ✓ 저장되었습니다. 이제 거래명세서 PDF를 발행할 수 있습니다.
        </p>
      )}
    </form>
  );
}
