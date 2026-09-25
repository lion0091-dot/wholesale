"use client";

import Link from "next/link";
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
      <div style={{ fontSize: "12px", fontWeight: 700, color: "#1d4ed8" }}>지금 할 일</div>
      <div>
        <div style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>{step.title}</div>
        {step.detail ? (
          <div style={{ fontSize: "13px", color: "#475569", marginTop: "4px" }}>{step.detail}</div>
        ) : null}
      </div>
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
