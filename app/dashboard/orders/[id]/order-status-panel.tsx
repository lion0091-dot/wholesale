"use client";

import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import {
  ORDER_STATUS_ACTIONS,
  ORDER_STATUS_BADGES,
  ORDER_STATUS_TRANSITIONS,
  isSupplierAssignableStatus,
  resolveAlimtalkStatus,
} from "@/lib/orders/status";
import { updateOrderStatusAction } from "../actions";
import type { OrderStatus } from "@/types/database";

interface OrderStatusPanelProps {
  orderId: string;
  currentStatus: OrderStatus;
}

const TONE_STYLES: Record<string, CSSProperties> = {
  primary: { backgroundColor: "#0f172a", color: "#ffffff", border: "1px solid #0f172a" },
  info: { backgroundColor: "#2563eb", color: "#ffffff", border: "1px solid #2563eb" },
  success: { backgroundColor: "#16a34a", color: "#ffffff", border: "1px solid #16a34a" },
  danger: { backgroundColor: "#ffffff", color: "#dc2626", border: "1px solid #fca5a5" },
};

export function OrderStatusPanel({
  orderId,
  currentStatus,
}: OrderStatusPanelProps) {
  const router = useRouter();
  const [status, setStatus] = useState<OrderStatus>(currentStatus);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  // 취소 요청(cancel_requested)은 바이어 전용이므로 공급사 버튼에서는 제외한다.
  const nextStatuses = ORDER_STATUS_TRANSITIONS[status].filter(isSupplierAssignableStatus);
  const badge = ORDER_STATUS_BADGES[status];

  const handleChange = async (nextStatus: OrderStatus) => {
    const action = ORDER_STATUS_ACTIONS[nextStatus];

    if (action.confirmMessage && !window.confirm(action.confirmMessage)) {
      return;
    }

    setPending(true);
    setMessage(null);

    const result = await updateOrderStatusAction(orderId, nextStatus);

    setPending(false);

    if (!result.success) {
      setMessage({ type: "error", text: result.error ?? "상태 변경에 실패했습니다." });
      return;
    }

    setStatus(nextStatus);
    setMessage({
      type: "success",
      text: `'${ORDER_STATUS_BADGES[nextStatus].label}'(으)로 변경되었습니다. ${
        resolveAlimtalkStatus(nextStatus).label
      } 알림톡이 발송됩니다.`,
    });
    router.refresh();
  };

  return (
    <section
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>발주 상태 처리</span>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 700,
            backgroundColor: badge.bg,
            color: badge.color,
            borderRadius: "4px",
            padding: "4px 8px",
          }}
        >
          현재: {badge.label}
        </span>
      </div>

      {message && (
        <div
          role="alert"
          style={{
            fontSize: "12px",
            padding: "9px 11px",
            borderRadius: "6px",
            backgroundColor: message.type === "error" ? "#fee2e2" : "#dcfce7",
            color: message.type === "error" ? "#991b1b" : "#166534",
          }}
        >
          {message.text}
        </div>
      )}

      {nextStatuses.length === 0 ? (
        <p style={{ fontSize: "12px", color: "#94a3b8" }}>
          처리가 완료된 발주서입니다. 더 이상 변경할 수 있는 상태가 없습니다.
        </p>
      ) : (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {nextStatuses.map((nextStatus) => {
            const action = ORDER_STATUS_ACTIONS[nextStatus];

            return (
              <button
                key={nextStatus}
                type="button"
                disabled={pending}
                onClick={() => void handleChange(nextStatus)}
                style={{
                  ...TONE_STYLES[action.tone],
                  fontSize: "13px",
                  fontWeight: 700,
                  padding: "9px 15px",
                  borderRadius: "8px",
                  cursor: pending ? "not-allowed" : "pointer",
                  opacity: pending ? 0.6 : 1,
                }}
              >
                {pending ? "처리 중..." : action.label}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
