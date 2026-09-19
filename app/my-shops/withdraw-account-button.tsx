"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { withdrawBuyerAccountAction } from "@/app/actions/buyer-auth";

/**
 * 바이어(구매회원) 회원탈퇴 버튼.
 *
 * 되돌릴 수 없는 조작이라 확인을 두 번 거친다(펼쳐진 안내 문구 + 클릭 시 confirm()).
 * 성공하면 세션이 이미 로그아웃 처리됐으므로 홈으로 이동한다.
 */
export function WithdrawAccountButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleWithdraw = () => {
    if (
      !confirm(
        "정말 탈퇴하시겠습니까?\n\n이름/연락처 등 개인정보는 즉시 삭제되고, 다시 로그인할 수 없습니다.\n이미 발생한 발주 내역은 법적 보관 의무에 따라 유지됩니다.\n\n이 작업은 되돌릴 수 없습니다."
      )
    ) {
      return;
    }

    setError(null);

    startTransition(async () => {
      const result = await withdrawBuyerAccountAction();

      if (!result.success) {
        setError(result.error ?? "회원탈퇴 처리에 실패했습니다.");
        return;
      }

      alert("회원탈퇴가 완료되었습니다. 이용해주셔서 감사합니다.");
      router.push("/");
    });
  };

  return (
    <div style={{ marginTop: "32px", paddingTop: "16px", borderTop: "1px solid #e2e8f0" }}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            fontSize: "12px",
            color: "#94a3b8",
            background: "none",
            border: "none",
            textDecoration: "underline",
            cursor: "pointer",
            padding: 0,
          }}
        >
          회원탈퇴
        </button>
      ) : (
        <div
          style={{
            border: "1px solid #fecaca",
            backgroundColor: "#fef2f2",
            borderRadius: "10px",
            padding: "16px",
          }}
        >
          <p style={{ fontSize: "12px", color: "#991b1b", lineHeight: 1.7, marginBottom: "12px" }}>
            탈퇴하면 이름/연락처 등 개인정보가 즉시 삭제되고 다시 로그인할 수 없습니다. 이미
            발생한 발주 내역은 법적 보관 의무에 따라 유지됩니다. 되돌릴 수 없는 작업입니다.
          </p>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              disabled={pending}
              onClick={handleWithdraw}
              style={{
                fontSize: "12px",
                fontWeight: 700,
                color: "#ffffff",
                backgroundColor: pending ? "#fca5a5" : "#b91c1c",
                border: "none",
                borderRadius: "6px",
                padding: "8px 14px",
                cursor: pending ? "wait" : "pointer",
              }}
            >
              {pending ? "처리 중..." : "탈퇴 확정"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setOpen(false)}
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "#475569",
                backgroundColor: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                padding: "8px 14px",
                cursor: pending ? "wait" : "pointer",
              }}
            >
              취소
            </button>
          </div>
          {error && (
            <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", marginTop: "8px" }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
