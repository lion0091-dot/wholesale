"use client";

import Link from "next/link";
import { WhoBadge } from "./step-card";
import { needsAttention, type InboundNextStep } from "@/lib/livestock/inbound-next-step";

export function InboundNextStepCard({ step }: { step: InboundNextStep }) {
  const attention = needsAttention(step);
  // 강조 카드는 어두운 바탕에 노란 버튼(반전), 평소 카드는 작고 옅게 — 진짜 할 일만 눈에 띄게 한다.
  const mainButtonStyle = {
    backgroundColor: attention ? "#facc15" : "#2563eb",
    color: attention ? "#0f172a" : "#ffffff",
    fontSize: attention ? "16px" : "14px",
    fontWeight: 800,
    padding: attention ? "12px 16px" : "9px 14px",
    borderRadius: "10px",
  } as const;

  const mainAction = step.buttonDisabled ? (
    <div
      aria-disabled="true"
      style={{
        textAlign: "center",
        backgroundColor: "#e2e8f0",
        color: "#64748b",
        fontSize: "13px",
        fontWeight: 800,
        padding: "8px 14px",
        borderRadius: "10px",
      }}
    >
      {step.buttonLabel}
    </div>
  ) : (
    <Link
      href={step.href}
      style={{
        display: "block",
        textAlign: "center",
        ...mainButtonStyle,
        textDecoration: "none",
      }}
    >
      {step.buttonLabel}
    </Link>
  );

  return (
    <section
      id="inbound-next-step"
      aria-label="지금 할 일"
      className={attention ? "inbound-attention" : undefined}
      style={{
        scrollMarginTop: "12px",
        border: attention ? "3px solid #facc15" : "1px solid #93c5fd",
        backgroundColor: attention ? "#0f172a" : "#eff6ff",
        borderRadius: "12px",
        padding: attention ? "14px 16px" : "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: attention ? "10px" : "6px",
      }}
    >
      {attention ? (
        <style>{`
          @keyframes inbound-attention-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(250, 204, 21, 0.75); }
            50% { box-shadow: 0 0 0 10px rgba(250, 204, 21, 0); }
          }
          .inbound-attention { animation: inbound-attention-pulse 1.6s ease-in-out infinite; }
          @media (prefers-reduced-motion: reduce) { .inbound-attention { animation: none; } }
        `}</style>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {attention ? (
          <span style={{ fontSize: "13px", fontWeight: 900, color: "#facc15" }}>▶ 여기를 보세요 · 지금 할 일</span>
        ) : (
          <span style={{ fontSize: "12px", fontWeight: 700, color: "#1d4ed8" }}>지금 할 일</span>
        )}
        <WhoBadge who={step.who} />
      </div>
      <div>
        <div style={{ fontSize: attention ? "19px" : "15px", fontWeight: 800, color: attention ? "#ffffff" : "#0f172a" }}>{step.title}</div>
        {step.detail ? (
          <div style={{ fontSize: "12px", color: attention ? "#e2e8f0" : "#475569", marginTop: "3px", lineHeight: 1.5 }}>{step.detail}</div>
        ) : null}
      </div>
      {step.waitNote ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
            border: "1px dashed #94a3b8",
            backgroundColor: "#f8fafc",
            borderRadius: "10px",
            padding: "10px 12px",
            fontSize: "13px",
            color: "#334155",
            lineHeight: 1.6,
          }}
        >
          <WhoBadge who={step.waitNote.who} />
          <span>{step.waitNote.text}</span>
        </div>
      ) : null}
      {mainAction}
      {step.secondaries.map((link) => (
        <Link
          key={link.label}
          href={link.href}
          style={{ fontSize: "12px", color: attention ? "#fde68a" : "#1d4ed8", textAlign: "center", textDecoration: "underline" }}
        >
          {link.label}
        </Link>
      ))}
    </section>
  );
}
