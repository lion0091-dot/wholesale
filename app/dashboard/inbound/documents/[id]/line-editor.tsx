"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateDocumentLineAction, type DocumentLinePatch } from "../../document-actions";
import type { ScanProductOption } from "../../inbound-scan-view";
import type { ReconciliationLine } from "./document-reconciliation-view";

/**
 * 전표 줄 내용 고치기 — 오타(수량·무게·번호·부위·상품 등)를 바로잡는다. 바꾼 칸만 보내고, 누가 언제 무엇을 바꿨는지 기록이 남는다.
 * 번호를 바꾸면 옛 번호로 이어졌던 박스가 풀리고 새 번호로 다시 이어진다. 재고는 바뀌지 않는다.
 */
export function LineEditor({ line, products, canEdit }: { line: ReconciliationLine; products: ScanProductOption[]; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const initial = {
    itemName: line.itemName ?? "",
    partName: line.partName ?? "",
    grade: line.grade ?? "",
    origin: line.origin ?? "",
    traceNo: line.traceNo ?? "",
    lotNo: line.lotNo ?? "",
    quantity: line.quantity === null ? "" : String(line.quantity),
    labeledWeight: line.labeledWeight === null ? "" : String(line.labeledWeight),
    unitPrice: line.unitPrice === null ? "" : String(line.unitPrice),
    amount: line.amount === null ? "" : String(line.amount),
    productId: line.productId ?? "",
  };
  const [values, setValues] = useState(initial);

  const set = (key: keyof typeof initial, value: string) => setValues((current) => ({ ...current, [key]: value }));

  const toNumber = (text: string): number | null => {
    const cleaned = text.replace(/,/g, "").trim();

    return cleaned === "" ? null : Number(cleaned);
  };

  const save = async () => {
    const patch: DocumentLinePatch = {};
    const numericKeys = ["quantity", "labeledWeight", "unitPrice", "amount"] as const;

    (Object.keys(initial) as Array<keyof typeof initial>).forEach((key) => {
      if (values[key] === initial[key]) return;

      if ((numericKeys as readonly string[]).includes(key)) {
        const number = toNumber(values[key]);

        if (values[key].trim() !== "" && !Number.isFinite(number)) return;

        (patch as Record<string, unknown>)[key] = number;
      } else {
        (patch as Record<string, unknown>)[key] = values[key].trim() === "" ? null : values[key].trim();
      }
    });

    if (Object.keys(patch).length === 0) {
      setNotice("바뀐 칸이 없습니다.");
      setError(null);

      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    const result = await updateDocumentLineAction(line.id, patch, reason);

    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "고치지 못했습니다.");

      return;
    }

    setOpen(false);
    setReason("");
    router.refresh();
  };

  const field = (label: string, key: keyof typeof initial, options: { mono?: boolean; width?: string; placeholder?: string } = {}) => (
    <label style={{ fontSize: "12px", color: "#475569", display: "flex", flexDirection: "column", gap: "3px", flex: `1 1 ${options.width ?? "120px"}` }}>
      {label}
      <input
        value={values[key]}
        onChange={(event) => set(key, event.target.value)}
        placeholder={options.placeholder}
        style={{ ...inputStyle, fontFamily: options.mono ? "monospace" : undefined }}
      />
    </label>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {!canEdit ? null : !open ? (
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => setOpen(true)} style={linkStyle}>
            줄 내용 고치기
          </button>
          {notice ? <span style={{ fontSize: "12px", color: "#64748b" }}>{notice}</span> : null}
        </div>
      ) : (
        <div style={{ border: "1px solid #bfdbfe", backgroundColor: "#f8fbff", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {field("품목", "itemName", { width: "160px" })}
            {field("부위", "partName")}
            {field("등급", "grade", { width: "80px" })}
            {field("원산지", "origin", { width: "90px" })}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {field("이력번호", "traceNo", { mono: true, width: "160px" })}
            {field("묶음번호", "lotNo", { mono: true, width: "160px" })}
            {field("수량(박스)", "quantity", { width: "90px" })}
            {field("중량(kg)", "labeledWeight", { width: "100px" })}
            {field("단가", "unitPrice", { width: "100px" })}
            {field("금액", "amount", { width: "110px" })}
          </div>
          <label style={{ fontSize: "12px", color: "#475569", display: "flex", flexDirection: "column", gap: "3px" }}>
            내 상품
            <select value={values.productId} onChange={(event) => set("productId", event.target.value)} style={{ ...inputStyle, maxWidth: "320px" }}>
              <option value="">선택 안 함</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: "12px", color: "#475569", display: "flex", flexDirection: "column", gap: "3px" }}>
            고치는 이유 (선택)
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="예: 수량을 5로 잘못 적음" style={inputStyle} />
          </label>
          <p style={{ margin: 0, fontSize: "11px", color: "#64748b", lineHeight: 1.6 }}>
            번호를 바꾸면 이 줄에 이어졌던 박스가 풀리고 새 번호로 다시 이어집니다. 재고는 바뀌지 않고, 고친 기록이 남습니다.
          </p>
          {error ? <p style={{ margin: 0, fontSize: "12px", color: "#991b1b" }}>{error}</p> : null}
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" onClick={() => void save()} disabled={busy} style={primaryStyle}>
              {busy ? "저장 중…" : "고친 내용 저장"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setValues(initial);
                setError(null);
              }}
              style={secondaryStyle}
            >
              취소
            </button>
          </div>
        </div>
      )}

      {line.edits.length > 0 ? (
        <details>
          <summary style={{ fontSize: "12px", color: "#475569", cursor: "pointer" }}>고친 기록 {line.edits.length}건</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: "18px", fontSize: "12px", color: "#334155", lineHeight: 1.7 }}>
            {line.edits.map((edit) => (
              <li key={edit.id}>
                {new Date(edit.editedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {edit.editedByName} —{" "}
                {edit.changes.map((change) => `${change.label} ${change.from} → ${change.to}`).join(", ")}
                {edit.reason ? ` (${edit.reason})` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: "1px solid #cbd5f5",
  borderRadius: "6px",
  padding: "6px 8px",
  fontSize: "12px",
  color: "#0f172a",
  backgroundColor: "#ffffff",
  width: "100%",
};

const linkStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  color: "#1d4ed8",
  fontSize: "12px",
  fontWeight: 700,
  cursor: "pointer",
  padding: 0,
};

const primaryStyle: React.CSSProperties = {
  border: "none",
  borderRadius: "8px",
  backgroundColor: "#0f172a",
  color: "#ffffff",
  fontSize: "12px",
  fontWeight: 700,
  padding: "8px 14px",
  cursor: "pointer",
};

const secondaryStyle: React.CSSProperties = {
  border: "1px solid #cbd5f5",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
  fontSize: "12px",
  fontWeight: 600,
  padding: "8px 14px",
  cursor: "pointer",
};
