"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtimeRefresh } from "@/lib/hooks/use-realtime-refresh";
import { courierLabel } from "@/lib/verification/sweettracker";
import { loadShopBellAction, markShopBellSeenAction, type ShopBellItem } from "./actions";

function formatShippedAt(value: string): string {
  const date = new Date(value);

  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 미니샵 알림벨 — 배송이 시작된 주문을 알려준다. 단골 인증을 마친 고객에게만 보인다.
 * 벨을 열면 지금까지의 알림을 확인한 것으로 저장하고(DB), 폰·PC 어디서 열어도 같은 상태가 보인다.
 * 화면을 열어둔 채로도 내 주문이 배송중으로 바뀌면 바로 갱신된다(Realtime). 2026-10-01까지는 열 때 한 번만 읽었다.
 */
export function ShopBell() {
  const params = useParams<{ shop_token: string }>();
  const shopToken = params?.shop_token ?? "";
  const [items, setItems] = useState<ShopBellItem[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [open, setOpen] = useState(false);
  const [retailerId, setRetailerId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!shopToken) return;

    void loadShopBellAction(shopToken).then((result) => {
      if (result.success && result.data) {
        setItems(result.data.items);
        setUnseen(result.data.unseenCount);
        setRetailerId(result.data.retailerId);
      }
    });
  }, [shopToken]);

  useEffect(() => {
    load();
  }, [load]);

  // 내 주문 행이 바뀌면(배송중 전환 등) 다시 읽는다. 어느 주문이 내 것인지는 서버(RLS)가 거른다.
  const watches = useMemo(
    () => (retailerId ? [{ table: "orders", filter: `retailer_id=eq.${retailerId}` }] : []),
    [retailerId]
  );

  useRealtimeRefresh(watches, load, { enabled: retailerId !== null });

  const toggle = () => {
    const next = !open;

    setOpen(next);

    // 목록에서는 이번에 새로 온 알림을 계속 강조하고, 배지만 끈다.
    if (next && unseen > 0) {
      setUnseen(0);
      void markShopBellSeenAction(shopToken);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={toggle}
        aria-label={unseen > 0 ? `새 알림 ${unseen}건` : "알림"}
        style={{
          position: "relative",
          background: "#ffffff",
          border: "1px solid #cbd5e1",
          borderRadius: "999px",
          width: "36px",
          height: "36px",
          fontSize: "16px",
          cursor: "pointer",
        }}
      >
        🔔
        {unseen > 0 && (
          <span
            style={{
              position: "absolute",
              top: "-4px",
              right: "-4px",
              minWidth: "18px",
              height: "18px",
              padding: "0 4px",
              borderRadius: "9px",
              backgroundColor: "#dc2626",
              color: "#ffffff",
              fontSize: "11px",
              fontWeight: 800,
              lineHeight: "18px",
              textAlign: "center",
            }}
          >
            {unseen}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "44px",
            width: "280px",
            maxHeight: "360px",
            overflowY: "auto",
            backgroundColor: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(15,23,42,0.12)",
            zIndex: 20,
          }}
        >
          {items.length === 0 ? (
            <div style={{ padding: "16px", fontSize: "13px", color: "#64748b" }}>
              최근 2주 안에 배송이 시작된 주문이 없습니다.
            </div>
          ) : (
            items.map((item) => (
              <Link
                key={item.orderId}
                href={`/shop/${shopToken}/orders`}
                style={{
                  display: "block",
                  padding: "12px 14px",
                  borderBottom: "1px solid #f1f5f9",
                  textDecoration: "none",
                  backgroundColor: item.isNew ? "#eff6ff" : "#ffffff",
                }}
              >
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
                  🚚 배송이 시작됐습니다
                </div>
                <div style={{ fontSize: "12px", color: "#475569", marginTop: "2px" }}>
                  주문 {item.orderNumber}
                </div>
                {item.courierCode && item.trackingNumber && (
                  <div style={{ fontSize: "12px", color: "#475569" }}>
                    {courierLabel(item.courierCode)} {item.trackingNumber}
                  </div>
                )}
                <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                  {formatShippedAt(item.shippedAt)}
                </div>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
