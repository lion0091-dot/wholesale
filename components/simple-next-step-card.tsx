import type { ReactNode } from "react";

export type NextStepTone = "blue" | "red" | "green";

const PALETTE: Record<NextStepTone, { border: string; background: string; label: string }> = {
  blue: { border: "#93c5fd", background: "#eff6ff", label: "#1d4ed8" },
  red: { border: "#fca5a5", background: "#fef2f2", label: "#b91c1c" },
  green: { border: "#bbf7d0", background: "#f0fdf4", label: "#166534" },
};

/** 버튼 모양(카드의 큰 행동 버튼). 링크·button 어디에든 같은 모양으로 쓴다. */
export const NEXT_STEP_BUTTON_STYLE = {
  display: "block",
  textAlign: "center" as const,
  border: "none",
  cursor: "pointer",
  backgroundColor: "#2563eb",
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: 800,
  padding: "9px 14px",
  borderRadius: "10px",
  textDecoration: "none",
};

/**
 * 화면 맨 위 "지금 할 일" 카드의 공통 모양(전표관리·보류함). 판단은 각 화면의 순수 함수가 하고 여기는 그리기만 한다.
 * tone=green은 "할 일 없음"(해야 할 게 없다는 것도 안내다).
 */
export function SimpleNextStepCard({
  tone,
  title,
  detail,
  action,
}: {
  tone: NextStepTone;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  const palette = PALETTE[tone];

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
      <span style={{ fontSize: "12px", fontWeight: 700, color: palette.label }}>{tone === "green" ? "지금 할 일 없음" : "지금 할 일"}</span>
      <div>
        <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{title}</div>
        <div style={{ fontSize: "13px", color: "#475569", marginTop: "3px", lineHeight: 1.6 }}>{detail}</div>
      </div>
      {action}
    </section>
  );
}
