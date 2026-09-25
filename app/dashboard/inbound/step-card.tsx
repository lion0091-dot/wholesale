import Link from "next/link";
import type { CSSProperties } from "react";
import type { ResultCard, ResultTone } from "@/lib/livestock/inbound-scan-result";

/** 카드가 지금 하라고 안내하는 입력칸·버튼을 눈에 띄게 하는 표시. */
export const HIGHLIGHT_FIELD: CSSProperties = {
  borderColor: "#2563eb",
  backgroundColor: "#eff6ff",
  boxShadow: "0 0 0 3px rgba(37, 99, 235, 0.35)",
};

export const HIGHLIGHT_BUTTON: CSSProperties = {
  boxShadow: "0 0 0 4px rgba(37, 99, 235, 0.45)",
};

export type Who = "사무실" | "현장" | "현장·사무실";

const WHO_STYLE: Record<Who, { bg: string; fg: string }> = {
  사무실: { bg: "#e0e7ff", fg: "#3730a3" },
  현장: { bg: "#ffedd5", fg: "#9a3412" },
  "현장·사무실": { bg: "#dcfce7", fg: "#166534" },
};

/** 이 단계를 누가 하는지 — 사무실 직원 / 현장 직원. 같은 "1단계"가 두 군데 있어도 헷갈리지 않게 한다. */
export function WhoBadge({ who }: { who: Who }) {
  return (
    <span
      style={{
        alignSelf: "flex-start",
        fontSize: "11px",
        fontWeight: 800,
        borderRadius: "999px",
        padding: "2px 9px",
        backgroundColor: WHO_STYLE[who].bg,
        color: WHO_STYLE[who].fg,
      }}
    >
      {who === "현장·사무실" ? who : `${who} 업무`}
    </span>
  );
}

export interface StepCardStep {
  title: string;
  detail: string;
  link?: { label: string; href: string };
  action?: { label: string; onClick: () => void };
}

export function StepCard({ step, who }: { step: StepCardStep; who?: Who }) {
  return (
    <div
      style={{
        border: "2px solid #2563eb",
        backgroundColor: "#eff6ff",
        borderRadius: "12px",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      {who ? <WhoBadge who={who} /> : null}
      <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{step.title}</div>
      <div style={{ fontSize: "13px", color: "#475569" }}>{step.detail}</div>
      {step.action ? (
        <button
          type="button"
          onClick={step.action.onClick}
          style={{
            backgroundColor: "#2563eb",
            color: "#ffffff",
            fontSize: "15px",
            fontWeight: 800,
            padding: "12px 14px",
            borderRadius: "10px",
            border: "none",
            cursor: "pointer",
          }}
        >
          {step.action.label}
        </button>
      ) : null}
      {step.link ? (
        <Link
          href={step.link.href}
          style={{
            display: "block",
            textAlign: "center",
            backgroundColor: "#2563eb",
            color: "#ffffff",
            fontSize: "15px",
            fontWeight: 800,
            padding: "12px 14px",
            borderRadius: "10px",
            textDecoration: "none",
          }}
        >
          {step.link.label}
        </Link>
      ) : null}
    </div>
  );
}

const TONE_STYLE: Record<ResultTone, { border: string; bg: string; fg: string; label: string }> = {
  green: { border: "#86efac", bg: "#f0fdf4", fg: "#166534", label: "완료" },
  yellow: { border: "#fcd34d", bg: "#fffbeb", fg: "#92400e", label: "확인 필요" },
  red: { border: "#fca5a5", bg: "#fef2f2", fg: "#991b1b", label: "처리 필요" },
};

/** 박스 하나를 등록한 직후의 결과 카드 — 초록(끝) / 노랑(입고됐지만 확인) / 빨강(사람이 처리해야 재고가 잡힘). */
export function ResultCardView({ card, onDismiss }: { card: ResultCard; onDismiss: () => void }) {
  const tone = TONE_STYLE[card.tone];

  return (
    <div
      role="status"
      style={{
        border: `2px solid ${tone.border}`,
        backgroundColor: tone.bg,
        borderRadius: "12px",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "flex-start" }}>
        <div>
          <span style={{ fontSize: "11px", fontWeight: 800, color: tone.fg }}>{tone.label}</span>
          <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a", marginTop: "2px" }}>{card.title}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="닫기"
          style={{ border: "none", background: "transparent", color: "#64748b", fontSize: "18px", cursor: "pointer" }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: "13px", color: "#334155", lineHeight: 1.6 }}>{card.detail}</div>
      {card.extras.map((extra) => (
        <div
          key={extra.title}
          style={{
            borderTop: "1px dashed #cbd5e1",
            paddingTop: "8px",
            fontSize: "13px",
            color: "#334155",
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: TONE_STYLE[extra.tone].fg }}>{extra.title}</strong>
          <div>{extra.detail}</div>
        </div>
      ))}
      {card.action ? (
        <Link
          href={card.action.href}
          style={{
            display: "block",
            textAlign: "center",
            backgroundColor: tone.fg,
            color: "#ffffff",
            fontSize: "14px",
            fontWeight: 800,
            padding: "10px 14px",
            borderRadius: "10px",
            textDecoration: "none",
          }}
        >
          {card.action.label}
        </Link>
      ) : null}
    </div>
  );
}
