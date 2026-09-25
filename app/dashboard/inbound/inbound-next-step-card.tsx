"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { closeInboundDocumentAction } from "./document-actions";
import { WhoBadge } from "./step-card";
import {
  INBOUND_ANCHORS,
  OPEN_DOCUMENT_PANEL_EVENT,
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

  // 현장 진행 상황을 기다리는 카드(스캔 중)는 30초마다 새로 불러와, 스캔 종료·전부 도착이 사무실 화면에 저절로 뜨게 한다.
  useEffect(() => {
    if (step.key !== "scan") return;

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 30_000);

    return () => window.clearInterval(timer);
  }, [step.key, router]);

  const closeNow = async () => {
    if (!step.closeDocumentId) return;

    if (!window.confirm("마감하면 이 명세서 확인이 끝납니다. 고칠 것이 생기면 '다시 열기'로 되돌릴 수 있습니다. 마감할까요?")) {
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

  return (
    <section
      id="inbound-next-step"
      aria-label="지금 할 일"
      style={{
        scrollMarginTop: "12px",
        border: "2px solid #2563eb",
        backgroundColor: "#eff6ff",
        borderRadius: "14px",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "#1d4ed8" }}>지금 할 일</span>
        <WhoBadge who={step.who} />
      </div>
      <div>
        <div style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>{step.title}</div>
        {step.detail ? (
          <div style={{ fontSize: "13px", color: "#475569", marginTop: "4px" }}>{step.detail}</div>
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
      {step.buttonDisabled ? (
        <div
          aria-disabled="true"
          style={{
            textAlign: "center",
            backgroundColor: "#e2e8f0",
            color: "#64748b",
            fontSize: "16px",
            fontWeight: 800,
            padding: "14px 16px",
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
            backgroundColor: "#2563eb",
            color: "#ffffff",
            fontSize: "16px",
            fontWeight: 800,
            padding: "14px 16px",
            borderRadius: "10px",
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
          backgroundColor: "#2563eb",
          color: "#ffffff",
          fontSize: "16px",
          fontWeight: 800,
          padding: "14px 16px",
          borderRadius: "10px",
          textDecoration: "none",
        }}
      >
        {step.buttonLabel}
      </Link>
      )}
      {closeError ? (
        <p style={{ margin: 0, fontSize: "13px", color: "#991b1b" }}>{closeError}</p>
      ) : null}
      {step.secondaries.map((link) => (
        <Link
          key={link.label}
          href={link.href}
          onClick={() => openDocumentPanelIfTargeted(link.href)}
          style={{ fontSize: "13px", color: "#1d4ed8", textAlign: "center", textDecoration: "underline" }}
        >
          {link.label}
        </Link>
      ))}
    </section>
  );
}
