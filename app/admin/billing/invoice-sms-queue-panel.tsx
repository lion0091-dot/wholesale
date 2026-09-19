"use client";

import { useState, useTransition } from "react";
import { generateInvoiceSmsQueueAction, sendInvoiceSmsQueueAction } from "./actions";
import type { OutboundSmsQueueRow } from "@/lib/notifications/sms-queue";

interface InvoiceSmsQueuePanelProps {
  initialQueue: OutboundSmsQueueRow[];
}

/**
 * 아이폰은 sms: 스킴에서 본문을 ?body=가 아니라 &body=로 넘겨야 채워진다
 * (customer-table.tsx의 handleSendSms와 동일한 이유).
 */
function handleSendSingle(row: OutboundSmsQueueRow) {
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const separator = isIOS ? "&" : "?";
  const digits = row.recipientPhone.replace(/[^0-9+]/g, "");

  window.location.href = `sms:${digits}${separator}body=${encodeURIComponent(row.messageBody)}`;
}

export function InvoiceSmsQueuePanel({ initialQueue }: InvoiceSmsQueuePanelProps) {
  const [queue, setQueue] = useState(initialQueue);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  };

  const handleGenerate = () => {
    setNotice(null);

    startTransition(async () => {
      const result = await generateInvoiceSmsQueueAction();

      if (!result.success) {
        setNotice(result.error ?? "발송 큐 생성에 실패했습니다.");
        return;
      }

      const { insertedCount, skippedNoPhoneCount } = result.data ?? { insertedCount: 0, skippedNoPhoneCount: 0 };

      if (insertedCount === 0) {
        // 새로고침할 필요가 없다(큐에 추가된 게 없으니) — 그리고 새로고침을 하면 이
        // 안내 문구가 뜨자마자 사라져서 아무 반응도 없는 것처럼 보이던 버그가 있었다.
        setNotice(
          skippedNoPhoneCount > 0
            ? `추가된 항목이 없습니다 — 대표 연락처 미등록 ${skippedNoPhoneCount}건은 문자를 보낼 수 없어 제외되었습니다.`
            : "추가할 미납 청구서가 없습니다 — 전부 완납 상태이거나 이미 큐에 들어가 있습니다."
        );
        return;
      }

      setNotice(
        `${insertedCount}건을 큐에 추가했습니다.${
          skippedNoPhoneCount > 0 ? ` (대표 연락처 미등록 ${skippedNoPhoneCount}건 제외)` : ""
        }`
      );

      // 페이지 서버 컴포넌트가 다음 방문 시 새로고침되므로, 지금은 클라이언트에서
      // 낙관적으로 새 항목을 알 수 없다 — 안내만 하고 새로고침을 유도한다.
      window.location.reload();
    });
  };

  const handleBulkSend = () => {
    if (selected.size === 0) {
      setNotice("발송할 항목을 먼저 선택해주세요.");
      return;
    }

    setNotice(null);

    startTransition(async () => {
      const result = await sendInvoiceSmsQueueAction(Array.from(selected));
      setNotice(result.error ?? "발송 처리에 실패했습니다.");
    });
  };

  return (
    <div
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
        <div>
          <span style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>청구서 문자 발송 큐</span>
          <p style={{ fontSize: "11px", color: "#94a3b8", margin: "2px 0 0" }}>
            미납 청구서를 큐에 채운 뒤, 원하는 건을 선택해 일괄발송하거나 건별로 직접 발송할 수 있습니다.
          </p>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={isPending}
          style={{
            fontSize: "12px",
            fontWeight: 700,
            color: "#334155",
            backgroundColor: "#f1f5f9",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            padding: "7px 12px",
            cursor: isPending ? "wait" : "pointer",
          }}
        >
          {isPending ? "처리 중..." : "미납 청구서 큐에 채우기"}
        </button>
      </div>

      {notice && (
        <p role="status" style={{ fontSize: "12px", color: "#334155", margin: 0 }}>
          {notice}
        </p>
      )}

      {queue.length === 0 ? (
        <p style={{ fontSize: "12px", color: "#94a3b8", margin: 0 }}>큐에 대기 중인 문자가 없습니다.</p>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "320px", overflowY: "auto" }}>
            {queue.map((row) => (
              <label
                key={row.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                  fontSize: "12px",
                  color: "#334155",
                  padding: "8px",
                  border: "1px solid #f1f5f9",
                  borderRadius: "6px",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => toggleSelected(row.id)}
                  style={{ marginTop: "2px" }}
                />
                <span style={{ flex: 1 }}>
                  <strong>{row.recipientName}</strong> ({row.recipientPhone}){" "}
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      padding: "1px 6px",
                      borderRadius: "4px",
                      backgroundColor: row.status === "sent" ? "#dcfce7" : "#fef3c7",
                      color: row.status === "sent" ? "#166534" : "#92400e",
                    }}
                  >
                    {row.status === "sent" ? "발송완료" : "대기"}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleSendSingle(row)}
                    style={{
                      marginLeft: "8px",
                      fontSize: "11px",
                      fontWeight: 700,
                      color: "#181600",
                      backgroundColor: "#fee500",
                      border: "1px solid #fde047",
                      borderRadius: "4px",
                      padding: "2px 8px",
                      cursor: "pointer",
                    }}
                  >
                    📱 이 건만 직접 발송
                  </button>
                </span>
              </label>
            ))}
          </div>

          <button
            type="button"
            onClick={handleBulkSend}
            disabled={isPending}
            style={{
              alignSelf: "flex-start",
              fontSize: "12px",
              fontWeight: 700,
              color: "#ffffff",
              backgroundColor: "#0f172a",
              border: "1px solid #0f172a",
              borderRadius: "6px",
              padding: "7px 14px",
              cursor: isPending ? "wait" : "pointer",
            }}
          >
            선택 {selected.size}건 일괄발송
          </button>
        </>
      )}
    </div>
  );
}
