"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatWon } from "@/lib/orders/status";
import { DISPOSAL_REASONS, previewDisposal, type DisposalReasonCode } from "@/lib/supplier/box-disposal";
import { disposeBoxAction } from "./actions";

/** 박스 한 줄의 "폐기" 버튼 — 눌러 펼치면 중량·사유·메모를 받는다. 대표에게만 보인다(서버도 한 번 더 막는다). */
export function DisposeBoxButton({ boxId, remaining, unit, label }: { boxId: string; remaining: number; unit: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [weightText, setWeightText] = useState("");
  const [reasonCode, setReasonCode] = useState<DisposalReasonCode>("EXPIRED");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const weight = weightText.trim() === "" ? null : Number(weightText);
  const preview = previewDisposal(remaining, null, weight, reasonCode, note);

  const submit = () => {
    if (preview.error || weight === null) {
      setError(preview.error);
      return;
    }

    // 폐기 기록은 고칠 수 없고 기본 입력값이 남은 양 전체라, 실수로 눌러도 한 번 더 확인한다.
    if (!window.confirm(`${label} ${weight}${unit}을(를) 폐기합니다. 폐기 기록은 고칠 수 없습니다. 계속할까요?`)) {
      return;
    }

    setError(null);

    startTransition(async () => {
      const result = await disposeBoxAction({ boxId, weight, reasonCode, note: note.trim(), expectedRemaining: remaining });

      if (!result.success) {
        setError(result.error ?? "폐기하지 못했습니다.");
        return;
      }

      window.alert(
        `${label} ${weight}${unit} 폐기했습니다.${result.lossAmount !== null && result.lossAmount !== undefined ? ` 손실 ${formatWon(result.lossAmount)}` : " (매입단가가 없어 손실 금액은 기록하지 않았습니다.)"}`
      );
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setWeightText(String(remaining));
        }}
        style={{ fontSize: "12px", fontWeight: 700, padding: "5px 12px", borderRadius: "999px", border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", cursor: "pointer" }}
      >
        폐기
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: "220px" }}>
      <input
        type="number"
        inputMode="decimal"
        step="0.001"
        min="0"
        value={weightText}
        onChange={(event) => setWeightText(event.target.value)}
        aria-label={`버릴 중량(${unit})`}
        placeholder={`버릴 중량(${unit})`}
        style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: "8px" }}
      />
      <select
        value={reasonCode}
        onChange={(event) => setReasonCode(event.target.value as DisposalReasonCode)}
        aria-label="폐기 사유"
        style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: "8px" }}
      >
        {DISPOSAL_REASONS.map((reason) => (
          <option key={reason.code} value={reason.code}>
            {reason.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={200}
        aria-label="메모"
        placeholder={reasonCode === "OTHER" ? "메모(필수)" : "메모(선택)"}
        style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: "8px" }}
      />
      <div style={{ fontSize: "12px", color: preview.error ? "#b91c1c" : "#334155" }}>
        {preview.error ?? `폐기하면 ${remaining}${unit} → ${preview.after}${unit} (손실 금액은 매입단가로 자동 계산)`}
      </div>
      {error && error !== preview.error && (
        <div role="alert" style={{ fontSize: "12px", color: "#b91c1c", fontWeight: 700 }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: "6px" }}>
        <button
          type="button"
          onClick={submit}
          disabled={pending || preview.error !== null}
          style={{ fontSize: "12px", fontWeight: 700, padding: "5px 12px", borderRadius: "999px", border: "none", background: pending || preview.error ? "#fca5a5" : "#b91c1c", color: "#fff", cursor: pending || preview.error ? "default" : "pointer" }}
        >
          {pending ? "처리 중…" : "폐기하기"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          style={{ fontSize: "12px", fontWeight: 700, padding: "5px 12px", borderRadius: "999px", border: "1px solid #cbd5e1", background: "#fff", color: "#475569", cursor: "pointer" }}
        >
          취소
        </button>
      </div>
    </div>
  );
}
