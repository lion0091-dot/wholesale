"use client";

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      style={{
        padding: "10px 16px",
        fontSize: "13px",
        fontWeight: 600,
        borderRadius: "6px",
        border: "none",
        backgroundColor: "#0f172a",
        color: "#fff",
        cursor: "pointer",
      }}
    >
      인쇄
    </button>
  );
}
