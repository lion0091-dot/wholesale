"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatWon } from "@/lib/orders/status";
import { updateOrderItemPriceAction } from "../actions";

interface Props {
  orderItemId: string;
  unitPrice: number;
  requestedUnitPrice: number | null;
}

/**
 * 전화로 흥정한 단가를 실제로 적용하는 인라인 편집 — 고객 희망가 바로 아래 둔다.
 * 서버 액션이 owner/manager 권한과 발주 잠금 여부를 확인하므로, 여기서는 역할을
 * 미리 가려내지 않고(매입단가 화면과 동일 관례) 실패 메시지를 그대로 보여준다.
 */
export function OrderItemPriceEditor({ orderItemId, unitPrice, requestedUnitPrice }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [priceInput, setPriceInput] = useState(String(unitPrice));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setPriceInput(String(requestedUnitPrice ?? unitPrice));
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const value = Number.parseFloat(priceInput);

    if (!Number.isFinite(value) || value < 0) {
      setError("단가를 숫자로 입력해주세요.");
      return;
    }

    setBusy(true);
    setError(null);

    const result = await updateOrderItemPriceAction(orderItemId, value);

    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "단가 확정에 실패했습니다.");
      return;
    }

    setEditing(false);
    router.refresh();
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={startEdit}
        style={{
          fontSize: "11px",
          color: "#2563eb",
          border: "none",
          background: "none",
          padding: 0,
          marginTop: "2px",
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        단가 확정
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
      <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
        <input
          type="number"
          min="0"
          step="100"
          value={priceInput}
          onChange={(event) => setPriceInput(event.target.value)}
          aria-label="확정 단가"
          style={{
            width: "90px",
            fontSize: "12px",
            padding: "4px 6px",
            borderRadius: "6px",
            border: "1px solid #cbd5e1",
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          style={{
            fontSize: "11px",
            fontWeight: 700,
            color: "#fff",
            backgroundColor: "#0f172a",
            border: "none",
            borderRadius: "6px",
            padding: "4px 8px",
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "저장 중…" : "확정"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          style={{
            fontSize: "11px",
            color: "#64748b",
            border: "none",
            background: "none",
            cursor: "pointer",
          }}
        >
          취소
        </button>
      </div>
      {error && <div style={{ fontSize: "11px", color: "#b91c1c" }}>{error}</div>}
      {requestedUnitPrice != null && (
        <div style={{ fontSize: "10px", color: "#94a3b8" }}>
          고객 희망 {formatWon(requestedUnitPrice)}
        </div>
      )}
    </div>
  );
}
