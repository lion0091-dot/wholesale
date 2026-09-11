"use client";

import { useTransition } from "react";
import { signOut } from "@/app/auth/actions";

/** 헤더용 로그아웃 버튼. signOut()은 성공 시 홈으로 redirect한다. */
export function SignOutButton() {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => void (await signOut()))}
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
