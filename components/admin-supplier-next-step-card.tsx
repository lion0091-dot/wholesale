"use client";

import type { AdminNextStep } from "@/lib/admin/supplier-next-step";

/**
 * [공급사 승인] 화면 맨 위 "지금 할 일" 카드. 판단은 lib/admin/supplier-next-step.ts.
 * 버튼은 해당 공급사 카드로 스크롤한다(목록 탭이 가려 두고 있어도 "전체"로 돌려놓고 이동 — 호출부가 처리).
 * "할 일 없음"도 카드로 보여 준다 — 운영팀이 "다 한 건지"를 목록을 훑어 확인하지 않게.
 */
export function AdminSupplierNextStepCard({ step, onGo }: { step: AdminNextStep; onGo: (supplierId: string) => void }) {
  const idle = step.key === "nothing";
  const palette = idle
    ? { border: "#bbf7d0", background: "#f0fdf4", label: "#166534", button: "#16a34a" }
    : step.key === "overdue"
      ? { border: "#fca5a5", background: "#fef2f2", label: "#b91c1c", button: "#dc2626" }
      : { border: "#93c5fd", background: "#eff6ff", label: "#1d4ed8", button: "#2563eb" };

  return (
    <section
      aria-label="지금 할 일"
      style={{
        border: `1px solid ${palette.border}`,
        backgroundColor: palette.background,
        borderRadius: "12px",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        marginBottom: "20px",
      }}
    >
      <span style={{ fontSize: "12px", fontWeight: 700, color: palette.label }}>{idle ? "지금 할 일 없음" : "지금 할 일"}</span>
      <div>
        <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{step.title}</div>
        <div style={{ fontSize: "13px", color: "#475569", marginTop: "3px", lineHeight: 1.6 }}>{step.detail}</div>
      </div>
      {step.buttonLabel && step.supplierId && (
        <button
          type="button"
          onClick={() => onGo(step.supplierId as string)}
          style={{
            border: "none",
            cursor: "pointer",
            textAlign: "center",
            backgroundColor: palette.button,
            color: "#ffffff",
            fontSize: "14px",
            fontWeight: 800,
            padding: "9px 14px",
            borderRadius: "10px",
          }}
        >
          {step.buttonLabel}
        </button>
      )}
    </section>
  );
}
