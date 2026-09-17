"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { withdrawWholesalerAccountAction } from "@/app/actions/supplier-auth";

/**
 * 공급사(도매업체) 사업 종료(탈퇴) 버튼.
 *
 * 되돌릴 수 없는 조작이라 확인을 두 번 거친다(펼쳐진 안내 문구 + 클릭 시 confirm()).
 * 미수금이 남아있으면 서버 액션이 OUTSTANDING_BALANCE_EXISTS 메시지로 거절한다.
 */
export function WithdrawWholesalerButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleWithdraw = () => {
    if (
      !confirm(
        "정말 사업을 종료(탈퇴)하시겠습니까?\n\n미니샵은 즉시 비활성화되고 신규 주문/초대장 발부가 막힙니다.\n대표자 개인정보는 즉시 삭제되고 다시 로그인할 수 없습니다.\n상호·사업자번호 등 사업자 정보와 기존 주문 내역은 고객의 거래 기록 보존을 위해 유지됩니다.\n\n이 작업은 되돌릴 수 없습니다."
      )
    ) {
      return;
    }

    setError(null);

    startTransition(async () => {
      const result = await withdrawWholesalerAccountAction();

      if (!result.success) {
        setError(result.error ?? "사업 종료 처리에 실패했습니다.");
        return;
      }

      alert("사업 종료(탈퇴) 처리가 완료되었습니다. 이용해주셔서 감사합니다.");
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
          사업 종료(회원탈퇴)
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
            미니샵이 즉시 비활성화되고 신규 주문·초대장 발부가 막힙니다. 대표자 개인정보는 즉시
            삭제됩니다. 상호·사업자번호와 기존 주문 내역은 고객의 거래 기록 보존을 위해 유지됩니다.
            미수금이 남아있으면 처리되지 않습니다. 되돌릴 수 없는 작업입니다.
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
              {pending ? "처리 중..." : "사업 종료 확정"}
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
