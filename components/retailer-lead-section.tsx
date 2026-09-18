"use client";

import { useState } from "react";
import { RetailerLeadForm } from "@/components/retailer-lead-form";

/** 대문 "고객(소매)이신가요?" 카드의 신청 버튼 ↔ 폼 토글. */
export function RetailerLeadSection() {
  const [showForm, setShowForm] = useState(false);

  if (showForm) {
    return <RetailerLeadForm />;
  }

  return (
    <button
      type="button"
      onClick={() => setShowForm(true)}
      style={{
        display: "block",
        width: "100%",
        backgroundColor: "#dc2626",
        color: "#ffffff",
        padding: "12px 16px",
        borderRadius: "8px",
        fontWeight: 700,
        fontSize: "14px",
        border: "none",
        cursor: "pointer",
      }}
    >
      입점 희망 신청하기 →
    </button>
  );
}
