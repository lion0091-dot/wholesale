"use client";

import { useCallback, useEffect, useState } from "react";
import { removePushSubscriptionAction, savePushSubscriptionAction } from "@/app/actions/push-subscription";

/** 빌드 때 박히는 공개키. 서버 쪽 키(비밀키·연락처)까지 다 있을 때만 쓴다 — 부모가 configured로 알려준다. */
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY ?? "";

export type PushState =
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
 * 이 브라우저의 웹푸시 상태와 켜기·끄기. 종 패널의 "이 기기로 알림 받기"(PushToggle)와
 * 대시보드 상단의 주문 알림 안내(OrderAlertGuard)가 같이 쓴다.
 * configured=false(서버에 키가 없음)면 아무것도 하지 않고 enabled=false를 돌려준다.
 */
export function useWebPush(configured: boolean) {
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

  return { enabled, state, error, enable, disable };
}
