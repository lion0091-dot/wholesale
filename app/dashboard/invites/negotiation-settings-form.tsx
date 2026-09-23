"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  saveNegotiationSettingsAction,
  type NegotiationSettingsStatus,
} from "@/app/actions/negotiation-settings";

interface NegotiationSettingsFormProps {
  initial: NegotiationSettingsStatus;
}

/**
 * 미니샵 장바구니 네고(희망가 제안 칸) 켜고 끄기.
 *
 * 알림톡·PG 설정과 같은 구조 — 이 화면에서 켜고 끄면 바로 반영된다.
 */
export function NegotiationSettingsForm({ initial }: NegotiationSettingsFormProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleToggle = () => {
    const next = !enabled;
    setError(null);
    setEnabled(next);

    startTransition(async () => {
      const result = await saveNegotiationSettingsAction(next);

      if (!result.success) {
        setEnabled(!next);
        setError(result.error ?? "저장에 실패했습니다.");
        return;
      }

      router.refresh();
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div
        role="switch"
        aria-checked={enabled}
        tabIndex={0}
        onClick={pending ? undefined : handleToggle}
        onKeyDown={(event) => {
          if (!pending && (event.key === " " || event.key === "Enter")) {
            event.preventDefault();
            handleToggle();
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "12px 14px",
          borderRadius: "10px",
          border: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
          cursor: pending ? "wait" : "pointer",
        }}
      >
        <div>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
            미니샵 장바구니에 희망가 제안 칸 노출
          </div>
          <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
            켜면 고객이 장바구니에서 품목별 희망 단가와 가격 관련 요청 메모를 남길 수 있습니다.
            실제 가격은 전화 등으로 협의 후 발주 상세에서 직접 확인·조정합니다.
          </div>
        </div>

        <div
          style={{
            flexShrink: 0,
            width: "44px",
            height: "24px",
            borderRadius: "999px",
            backgroundColor: enabled ? "#0f172a" : "#cbd5e1",
            position: "relative",
            transition: "background-color 0.15s",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: "2px",
              left: enabled ? "22px" : "2px",
              width: "20px",
              height: "20px",
              borderRadius: "50%",
              backgroundColor: "#ffffff",
              transition: "left 0.15s",
            }}
          />
        </div>
      </div>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", lineHeight: 1.6 }}>
          {error}
        </p>
      )}
    </div>
  );
}
