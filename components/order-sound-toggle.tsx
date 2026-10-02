"use client";

import { useEffect, useState } from "react";
import { isOrderSoundMuted, playOrderChime, setOrderSoundMuted } from "@/lib/notifications/order-alert-sound";

/** 종 패널의 "새 주문 소리" 한 줄 — 화면이 열려 있을 때 새 주문이 오면 나는 소리·진동을 끄고 켠다(이 브라우저 기준). */
export function OrderSoundToggle() {
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(isOrderSoundMuted());
  }, []);

  const toggle = () => {
    const next = !muted;

    setOrderSoundMuted(next);
    setMuted(next);

    // 켤 때 한 번 들려줘서 소리가 나는지 바로 확인하게 한다(클릭이 오디오 잠금도 풀어 준다).
    if (!next) playOrderChime();
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        margin: "0 4px 4px",
        padding: "8px 6px 10px",
        borderBottom: "1px solid #e2e8f0",
        fontSize: "12px",
        color: "#334155",
      }}
    >
      <span>
        <strong>새 주문 소리</strong> — 화면을 켜 둔 동안 새 주문이 오면 소리가 납니다
      </span>
      <button
        type="button"
        onClick={toggle}
        style={{ flexShrink: 0, border: "1px solid #bfdbfe", borderRadius: "6px", padding: "4px 10px", fontSize: "12px", fontWeight: 700, color: "#2563eb", backgroundColor: "#ffffff", cursor: "pointer" }}
      >
        {muted ? "켜기" : "끄기"}
      </button>
    </div>
  );
}
