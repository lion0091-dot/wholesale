"use client";

import { useMemo, useState, useTransition } from "react";
import { formatOrderedAt, formatWon } from "@/lib/orders/status";
import { sendReceivablesReminderAction, settleCreditOrdersAction } from "./actions";
import type { ReceivableCustomerGroup } from "./receivable-types";

interface ReceivablesViewProps {
  groups: ReceivableCustomerGroup[];
  /** 데모(샘플) 데이터 여부 — 정산 처리를 막는다 */
  readOnly?: boolean;
}

export function ReceivablesView({ groups, readOnly = false }: ReceivablesViewProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);
  const [errorByGroup, setErrorByGroup] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  const [reminderPendingGroupId, setReminderPendingGroupId] = useState<string | null>(null);
  const [reminderStatusByGroup, setReminderStatusByGroup] = useState<
    Record<string, { type: "success" | "error"; text: string } | undefined>
  >({});
  const [isReminderPending, startReminderTransition] = useTransition();

  const toggleOrder = (orderId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);

      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
      }

      return next;
    });
  };

  const toggleGroup = (group: ReceivableCustomerGroup, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);

      for (const order of group.orders) {
        if (checked) {
          next.add(order.id);
        } else {
          next.delete(order.id);
        }
      }

      return next;
    });
  };

  const handleSettle = (group: ReceivableCustomerGroup) => {
    if (readOnly) {
      window.alert("샘플 데이터입니다. 로그인 후 실제 거래처에서 이용해주세요.");
      return;
    }

    const orderIds = group.orders.filter((order) => selected.has(order.id)).map((order) => order.id);

    if (orderIds.length === 0) {
      setErrorByGroup((prev) => ({ ...prev, [group.retailerId]: "정산할 주문을 선택해주세요." }));
      return;
    }

    setErrorByGroup((prev) => ({ ...prev, [group.retailerId]: "" }));
    setPendingGroupId(group.retailerId);

    startTransition(async () => {
      const result = await settleCreditOrdersAction(orderIds);

      if (result.success) {
        setSelected((prev) => {
          const next = new Set(prev);
          orderIds.forEach((id) => next.delete(id));
          return next;
        });
      } else {
        setErrorByGroup((prev) => ({
          ...prev,
          [group.retailerId]: result.error ?? "정산 처리에 실패했습니다.",
        }));
      }

      setPendingGroupId(null);
    });
  };

  const handleSendReminder = (group: ReceivableCustomerGroup) => {
    if (readOnly) {
      window.alert("샘플 데이터입니다. 로그인 후 실제 거래처에서 이용해주세요.");
      return;
    }

    setReminderStatusByGroup((prev) => ({ ...prev, [group.retailerId]: undefined }));
    setReminderPendingGroupId(group.retailerId);

    startReminderTransition(async () => {
      const result = await sendReceivablesReminderAction(group.retailerId);

      setReminderStatusByGroup((prev) => ({
        ...prev,
        [group.retailerId]: result.success
          ? { type: "success", text: result.data ?? "리마인드를 발송했습니다." }
          : { type: "error", text: result.error ?? "리마인드 발송에 실패했습니다." },
      }));

      setReminderPendingGroupId(null);
    });
  };

  const totalSelected = useMemo(() => selected.size, [selected]);

  if (groups.length === 0) {
    return (
      <section
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "48px 20px",
          textAlign: "center",
        }}
      >
        <p style={{ fontSize: "13px", color: "#94a3b8" }}>미정산 외상 주문이 없습니다.</p>
      </section>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {totalSelected > 0 && (
        <div style={{ fontSize: "12px", color: "#475569" }}>{totalSelected}건 선택됨</div>
      )}

      {groups.map((group) => {
        const allSelected = group.orders.every((order) => selected.has(order.id));
        const groupPending = isPending && pendingGroupId === group.retailerId;
        const groupError = errorByGroup[group.retailerId];
        const hasOverdue = group.orders.some((order) => order.isOverdue);
        const reminderPending = isReminderPending && reminderPendingGroupId === group.retailerId;
        const reminderStatus = reminderStatusByGroup[group.retailerId];

        return (
          <section
            key={group.retailerId}
            style={{
              backgroundColor: "#ffffff",
              border: `1px solid ${hasOverdue ? "#fecaca" : "#e2e8f0"}`,
              borderRadius: "12px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "10px",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "14px 16px",
                borderBottom: "1px solid #f1f5f9",
                backgroundColor: hasOverdue ? "#fef2f2" : "#f8fafc",
              }}
            >
              <div>
                <div style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>
                  {group.restaurantName}
                  {hasOverdue && (
                    <span
                      style={{
                        marginLeft: "8px",
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "#b91c1c",
                        backgroundColor: "#fee2e2",
                        borderRadius: "4px",
                        padding: "2px 6px",
                      }}
                    >
                      연체
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
                  한도 {formatWon(group.creditLimit)} · 미수금 {formatWon(group.outstandingBalance)} ·
                  연체 기준 {group.settlementDueDays}일
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => handleSendReminder(group)}
                  disabled={reminderPending}
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    padding: "8px 14px",
                    borderRadius: "7px",
                    border: "1px solid #cbd5e1",
                    backgroundColor: reminderPending ? "#f1f5f9" : "#ffffff",
                    color: "#334155",
                    cursor: reminderPending ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {reminderPending ? "발송 중..." : "리마인드 발송"}
                </button>

                <button
                  type="button"
                  onClick={() => handleSettle(group)}
                  disabled={groupPending}
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    padding: "8px 14px",
                    borderRadius: "7px",
                    border: "none",
                    backgroundColor: groupPending ? "#94a3b8" : "#0f172a",
                    color: "#ffffff",
                    cursor: groupPending ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {groupPending ? "처리 중..." : "선택 항목 정산 완료"}
                </button>
              </div>
            </div>

            {groupError && (
              <div
                role="alert"
                style={{
                  backgroundColor: "#fee2e2",
                  color: "#991b1b",
                  fontSize: "12px",
                  padding: "8px 16px",
                }}
              >
                {groupError}
              </div>
            )}

            {reminderStatus && (
              <div
                role="status"
                style={{
                  backgroundColor: reminderStatus.type === "success" ? "#f0fdf4" : "#fee2e2",
                  color: reminderStatus.type === "success" ? "#166534" : "#991b1b",
                  fontSize: "12px",
                  padding: "8px 16px",
                }}
              >
                {reminderStatus.text}
              </div>
            )}

            <div className="dash-table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th style={{ width: "36px" }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={(event) => toggleGroup(group, event.target.checked)}
                        aria-label={`${group.restaurantName} 전체 선택`}
                      />
                    </th>
                    <th>주문번호</th>
                    <th>주문일</th>
                    <th>정산 기한</th>
                    <th>금액</th>
                  </tr>
                </thead>
                <tbody>
                  {group.orders.map((order) => (
                    <tr key={order.id} style={{ backgroundColor: order.isOverdue ? "#fef2f2" : undefined }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(order.id)}
                          onChange={() => toggleOrder(order.id)}
                          aria-label={`${order.orderNumber} 선택`}
                        />
                      </td>
                      <td style={{ fontSize: "12px", fontWeight: 700 }}>{order.orderNumber}</td>
                      <td style={{ fontSize: "12px", color: "#64748b" }}>
                        {formatOrderedAt(order.orderedAt)}
                      </td>
                      <td style={{ fontSize: "12px", color: order.isOverdue ? "#b91c1c" : "#64748b" }}>
                        {formatOrderedAt(order.dueAt)}
                        {order.isOverdue && " (연체)"}
                      </td>
                      <td style={{ fontSize: "12px", fontWeight: 700 }}>{formatWon(order.totalAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
