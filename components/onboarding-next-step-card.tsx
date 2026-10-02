import Link from "next/link";
import type { OnboardingNextStep } from "@/lib/supplier/onboarding-next-step";

/**
 * 공급사 대시보드 맨 위 "지금 할 일" 카드 — 가입부터 첫 고객 초대까지 하나씩 안내한다.
 * 판단은 lib/supplier/onboarding-next-step.ts, 여기는 그리기만 한다. 거절·정지는 빨간색, 나머지는 파란색.
 */
export function OnboardingNextStepCard({ step }: { step: OnboardingNextStep | null }) {
  if (!step) return null;

  const warning = step.key === "rejected" || step.key === "suspended" || step.key === "fix-business-info";
  const palette = warning
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
      }}
    >
      <span style={{ fontSize: "12px", fontWeight: 700, color: palette.label }}>지금 할 일</span>
      <div>
        <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{step.title}</div>
        <div style={{ fontSize: "13px", color: "#475569", marginTop: "3px", lineHeight: 1.6 }}>{step.detail}</div>
      </div>
      {step.button && (
        <Link
          href={step.button.href}
          style={{
            display: "block",
            textAlign: "center",
            backgroundColor: palette.button,
            color: "#ffffff",
            fontSize: "14px",
            fontWeight: 800,
            padding: "9px 14px",
            borderRadius: "10px",
            textDecoration: "none",
          }}
        >
          {step.button.label}
        </Link>
      )}
    </section>
  );
}
