"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatWon } from "@/lib/orders/status";
import type { ReceivableCustomerGroup } from "@/lib/orders/receivables";
import { settleCreditOrdersAction } from "../../receivables/actions";

const cardStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  backgroundColor: "#fff",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

export function QuickSettleView({ groups }: { groups: ReceivableCustomerGroup[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyRetailerId, setBusyRetailerId] = useState<string | null>(null);
  const [errorByRetailer, setErrorByRetailer] = useState<Record<string, string>>({});

  const handleSettleAll = (group: ReceivableCustomerGroup) => {
    // 모바일 간이판은 개별 발주 선택 없이 "이 거래처가 방금 다 냈다"를 한 번에 처리한다
    // (개별 선택이 필요하면 PC 전체 화면으로). 정산은 되돌릴 수 없어 한 번 더 확인받는다.
    if (
      !window.confirm(
        `${group.restaurantName}의 미수금 ${formatWon(group.outstandingBalance)}(${group.orders.length}건)를 전부 정산 처리할까요?`
      )
    ) {
      return;
    }

    setErrorByRetailer((prev) => ({ ...prev, [group.retailerId]: "" }));
    setBusyRetailerId(group.retailerId);

    const orderIds = group.orders.map((order) => order.id);

    startTransition(async () => {
      const result = await settleCreditOrdersAction(orderIds);

      if (result.success) {
        router.refresh();
      } else {
        setErrorByRetailer((prev) => ({
          ...prev,
          [group.retailerId]: result.error ?? "정산 처리에 실패했습니다.",
        }));
      }

      setBusyRetailerId(null);
    });
  };

  if (groups.length === 0) {
    return <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>미수금이 있는 거래처가 없습니다.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {groups.map((group) => {
        const overdue = group.orders.some((order) => order.isOverdue);
        const isBusy = pending && busyRetailerId === group.retailerId;

        return (
          <div key={group.retailerId} style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                  {group.restaurantName}
                </div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                  {group.orders.length}건 미정산{overdue ? " · 연체 포함" : ""}
                </div>
              </div>

              <div style={{ fontSize: "17px", fontWeight: 800, color: overdue ? "#b91c1c" : "#0f172a" }}>
                {formatWon(group.outstandingBalance)}
              </div>
            </div>

            {errorByRetailer[group.retailerId] && (
              <p style={{ fontSize: "12px", color: "#b91c1c", margin: 0 }}>
                {errorByRetailer[group.retailerId]}
              </p>
            )}

            <button
              type="button"
              disabled={isBusy}
              onClick={() => handleSettleAll(group)}
              style={{
                padding: "9px 12px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: "#0f172a",
                color: "#fff",
                fontSize: "13px",
                fontWeight: 700,
                opacity: isBusy ? 0.6 : 1,
              }}
            >
              {isBusy ? "처리 중…" : "전액 정산 처리"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
