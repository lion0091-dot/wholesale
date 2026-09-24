"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveMinOrderAmountAction, type OrderPolicySettings } from "@/app/actions/order-policy-settings";

interface MinOrderAmountFormProps {
  initial: OrderPolicySettings;
}

/** 숫자만 남긴 문자열에 천 단위 콤마를 붙인다 ("50000" -> "50,000"). */
function formatThousands(digitsOnly: string): string {
  if (!digitsOnly) return "";
  return Number(digitsOnly).toLocaleString("ko-KR");
}

/**
 * 배송 1건 기준 최소 주문 금액 설정. 알림톡·PG·네고 설정과 같은 구조 —
 * 저장하면 바로 미니샵 장바구니/체크아웃에 반영된다.
 */
export function MinOrderAmountForm({ initial }: MinOrderAmountFormProps) {
  const router = useRouter();
  const [amount, setAmount] = useState(String(initial.minOrderAmount));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSave = () => {
    const parsed = Number.parseFloat(amount || "0");

    if (!Number.isFinite(parsed) || parsed < 0) {
      setError("0 이상의 숫자를 입력해주세요.");
      return;
    }

    setError(null);

    startTransition(async () => {
      const result = await saveMinOrderAmountAction(parsed);

      if (!result.success) {
        setError(result.error ?? "저장에 실패했습니다.");
        return;
      }

      router.refresh();
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
          최소 주문 금액 (배송 1건 기준)
        </div>
        <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
          손님이 이 금액 미만으로는 발주할 수 없습니다. 미니샵 장바구니/체크아웃 화면에 바로 반영됩니다.
        </div>
      </div>

      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          inputMode="numeric"
          value={formatThousands(amount)}
          onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ""))}
          placeholder="50,000"
          style={{
            width: "140px",
            padding: "9px 11px",
            fontSize: "14px",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
          }}
        />
        <span style={{ fontSize: "13px", color: "#475569" }}>원</span>
        <button
          type="button"
          onClick={handleSave}
          disabled={pending}
          style={{
            padding: "9px 16px",
            fontSize: "13px",
            fontWeight: 700,
            borderRadius: "6px",
            border: "none",
            backgroundColor: pending ? "#93c5fd" : "#0f172a",
            color: "#ffffff",
            cursor: pending ? "wait" : "pointer",
          }}
        >
          {pending ? "저장 중..." : "저장"}
        </button>
      </div>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", lineHeight: 1.6 }}>
          {error}
        </p>
      )}
    </div>
  );
}
