"use client";

import { useTransition } from "react";
import { signOut } from "@/app/auth/actions";
import { removePushSubscriptionAction } from "@/app/actions/push-subscription";

/**
 * 로그아웃 전에 이 브라우저의 웹푸시 구독을 푼다 — 사무실 PC를 다른 계정이 이어 쓰면 전 계정 업체의 새 주문 알림이
 * 계속 뜨기 때문(코드리뷰 2026-10-01). 구독이 없거나(고객·푸시 안 켬) 실패해도 로그아웃은 그대로 진행한다.
 */
async function releaseThisBrowserPush(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) return;

    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();

    if (!subscription) return;

    const endpoint = subscription.endpoint;

    await subscription.unsubscribe();
    await removePushSubscriptionAction(endpoint);
  } catch {
    // 알림 정리는 부가 동작 — 로그아웃을 막지 않는다.
  }
}

/** 헤더용 로그아웃 버튼. signOut()은 성공 시 홈으로 redirect한다. */
export function SignOutButton() {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await releaseThisBrowserPush();
          void (await signOut());
        })
      }
      style={{
        fontSize: "12px",
        fontWeight: 600,
        color: "#475569",
        backgroundColor: "#f1f5f9",
        border: "1px solid #e2e8f0",
        borderRadius: "6px",
        padding: "7px 11px",
        cursor: pending ? "wait" : "pointer",
      }}
    >
      {pending ? "로그아웃 중..." : "로그아웃"}
    </button>
  );
}
