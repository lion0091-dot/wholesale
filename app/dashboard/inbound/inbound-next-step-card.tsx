"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { closeInboundDocumentAction } from "./document-actions";
import { WhoBadge } from "./step-card";
import {
  INBOUND_ANCHORS,
  OPEN_DOCUMENT_PANEL_EVENT,
  needsAttention,
  type InboundNextStep,
} from "@/lib/livestock/inbound-next-step";

function openDocumentPanelIfTargeted(href: string) {
  if (href === INBOUND_ANCHORS.documents) {
    window.dispatchEvent(new Event(OPEN_DOCUMENT_PANEL_EVENT));
  }
}

export function InboundNextStepCard({ step }: { step: InboundNextStep }) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // 현장 진행 상황을 기다리는 카드(스캔 중·스캔 종료)는 새로 불러와, 스캔 종료·다시 시작·전부 도착이
  // 사무실 화면에 저절로 뜨게 한다. 스캔 종료 카드도 포함해야 현장이 '스캔 다시 시작'을 눌렀을 때
  // 사무실이 낡은 화면으로 마감하지 않는다. 숨은 탭은 건너뛰고, 탭으로 돌아오는 즉시 한 번 새로 불러온다.
  useEffect(() => {
    if (step.key !== "scan" && step.key !== "scan-finished") return;

    let lastRefreshAt = Date.now();

    const refresh = () => {
      lastRefreshAt = Date.now();
      router.refresh();
    };

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);

    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefreshAt > 10_000) refresh();
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [step.key, router]);

  const closeNow = async () => {
    if (!step.closeDocumentId) return;

    if (!window.confirm("마감하면 이 전표 확인이 끝납니다. 고칠 것이 생기면 '다시 열기'로 되돌릴 수 있습니다. 마감할까요?")) {
      return;
    }

    setClosing(true);
    setCloseError(null);

    const result = await closeInboundDocumentAction(step.closeDocumentId, null);

    setClosing(false);

    if (!result.success) {
      setCloseError(result.error ?? "마감하지 못했습니다.");
      return;
    }

    router.refresh();
  };

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
  ) : step.closeDocumentId ? (
    <button
      type="button"
      onClick={() => void closeNow()}
      disabled={closing}
      style={{
        width: "100%",
        ...mainButtonStyle,
        border: "none",
        cursor: closing ? "default" : "pointer",
      }}
    >
      {closing ? "마감 중…" : step.buttonLabel}
    </button>
  ) : (
    <Link
      href={step.href}
      onClick={() => openDocumentPanelIfTargeted(step.href)}
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
      {closeError ? (
        <p style={{ margin: 0, fontSize: "13px", color: "#991b1b" }}>{closeError}</p>
      ) : null}
      {step.secondaries.map((link) => (
        <Link
          key={link.label}
          href={link.href}
          onClick={() => openDocumentPanelIfTargeted(link.href)}
          style={{ fontSize: "12px", color: attention ? "#fde68a" : "#1d4ed8", textAlign: "center", textDecoration: "underline" }}
        >
          {link.label}
        </Link>
      ))}
    </section>
  );
}
