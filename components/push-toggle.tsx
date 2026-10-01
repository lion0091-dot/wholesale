"use client";

import { useCallback, useEffect, useState } from "react";
import { removePushSubscriptionAction, savePushSubscriptionAction } from "@/app/actions/push-subscription";

/** 빌드 때 박히는 공개키. 서버 쪽 키(비밀키·연락처)까지 다 있을 때만 그린다 — 부모가 configured로 알려준다. */
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY ?? "";

type PushState =
  | "checking"
  | "unsupported" // 브라우저가 푸시를 못 함(구형·카톡 안 브라우저 등)
  | "ios-install" // 아이폰은 홈 화면에 추가한 앱에서만 됨
  | "denied" // 사용자가 브라우저에서 알림을 차단함
  | "off"
  | "on"
  | "busy";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));

  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);

  return bytes;
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * 종 패널 맨 위 "이 폰으로 알림 받기" 한 줄. 켜면 이 브라우저가 새 주문·주문 수정·취소 요청·여신 초과 알림을
 * 화면이 꺼져 있어도 받는다(웹푸시). 켜고 끄는 건 브라우저 하나 단위다 — 폰·PC 각각 켜야 한다.
 */
export function PushToggle({ configured }: { configured: boolean }) {
  const enabled = configured && Boolean(VAPID_PUBLIC_KEY);
  const [state, setState] = useState<PushState>("checking");
  const [error, setError] = useState<string | null>(null);

  const registration = useCallback(async () => {
    const existing = await navigator.serviceWorker.getRegistration("/");

    return existing ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const check = async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setState("unsupported");

        return;
      }

      if (isIos() && !isStandalone()) {
        setState("ios-install");

        return;
      }

      if (Notification.permission === "denied") {
        setState("denied");

        return;
      }

      try {
        const reg = await registration();
        const subscription = await reg.pushManager.getSubscription();

        if (cancelled) return;

        if (!subscription) {
          setState("off");

          return;
        }

        // 브라우저엔 구독이 남아 있는데 서버 행이 없거나 다른 계정 것일 수 있다(계정 바뀜·DB 정리). 다시 맞춰 두되,
        // 서버가 거절하면 "켜진 척"하지 않는다 — 구독을 풀고 꺼짐으로 보여 사용자가 다시 켤 수 있게 한다.
        const json = subscription.toJSON();
        const result =
          json.endpoint && json.keys?.p256dh && json.keys?.auth
            ? await savePushSubscriptionAction({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } })
            : { success: false, error: "브라우저가 알림 주소를 주지 않았습니다." };

        if (cancelled) return;

        if (result.success) {
          setState("on");
        } else {
          await subscription.unsubscribe().catch(() => undefined);
          setError(result.error ?? "알림 설정을 다시 확인하지 못했습니다. 다시 켜주세요.");
          setState("off");
        }
      } catch {
        if (!cancelled) setState("unsupported");
      }
    };

    void check();

    return () => {
      cancelled = true;
    };
  }, [enabled, registration]);

  const enable = async () => {
    setError(null);
    setState("busy");

    try {
      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");

        return;
      }

      const reg = await registration();
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      const json = subscription.toJSON();

      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("브라우저가 알림 주소를 주지 않았습니다.");
      }

      const result = await savePushSubscriptionAction({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });

      if (!result.success) {
        await subscription.unsubscribe();
        throw new Error(result.error ?? "알림 설정을 저장하지 못했습니다.");
      }

      setState("on");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "알림을 켜지 못했습니다.");
      setState("off");
    }
  };

  const disable = async () => {
    setError(null);
    setState("busy");

    try {
      const reg = await registration();
      const subscription = await reg.pushManager.getSubscription();

      if (subscription) {
        const endpoint = subscription.endpoint;

        await subscription.unsubscribe();
        await removePushSubscriptionAction(endpoint);
      }

      setState("off");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "알림을 끄지 못했습니다.");
      setState("on");
    }
  };

  if (!enabled || state === "checking" || state === "unsupported") return null;

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
    margin: "0 4px 4px",
    padding: "8px 6px 10px",
    borderBottom: "1px solid #e2e8f0",
    fontSize: "12px",
    color: "#334155",
  };

  const buttonStyle: React.CSSProperties = {
    flexShrink: 0,
    border: "1px solid #bfdbfe",
    borderRadius: "6px",
    padding: "4px 10px",
    fontSize: "12px",
    fontWeight: 700,
    color: "#2563eb",
    backgroundColor: "#ffffff",
    cursor: "pointer",
  };

  if (state === "ios-install") {
    return (
      <div style={rowStyle}>
        <span>
          아이폰은 <strong>홈 화면에 추가</strong>한 앱에서만 알림을 켤 수 있습니다. 사파리 공유 버튼 → &quot;홈 화면에 추가&quot;.
        </span>
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div style={rowStyle}>
        <span>이 브라우저에서 알림이 차단돼 있습니다. 주소창 옆 자물쇠(설정)에서 알림을 허용한 뒤 다시 열어주세요.</span>
      </div>
    );
  }

  return (
    <div style={rowStyle}>
      <span>
        {state === "on" ? (
          <>
            <strong style={{ color: "#166534" }}>이 기기로 알림 받는 중</strong> — 새 주문·취소 요청이 화면이 꺼져 있어도 옵니다
          </>
        ) : (
          <>
            <strong>이 기기로 알림 받기</strong> — 새 주문·취소 요청을 화면이 꺼져 있어도 받습니다
          </>
        )}
        {error && <div style={{ color: "#b91c1c", marginTop: "2px" }}>{error}</div>}
      </span>
      <button type="button" onClick={state === "on" ? disable : enable} disabled={state === "busy"} style={buttonStyle}>
        {state === "busy" ? "…" : state === "on" ? "끄기" : "켜기"}
      </button>
    </div>
  );
}
