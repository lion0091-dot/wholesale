"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { replaceScanTraceNoAction, type ReplaceTraceResult } from "./actions";

/**
 * "이력 못 찾음" 박스 옆에서 번호를 바로잡거나 다시 조회한다. 박스를 취소하고 다시 찍을 필요가 없다 —
 * 실중량·보관위치·유통기한은 그대로 옮겨지고, 조회가 되면 상품 생성·재고 반영·전표 연결까지 저절로 이어진다.
 */
export function TraceNoFixer({ scanId, traceNo, compact = false }: { scanId: string; traceNo: string; compact?: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(traceNo);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  const describe = (result: ReplaceTraceResult) => {
    if (!result.changed) {
      return { tone: "warn" as const, text: "다시 조회했지만 아직 이력에서 찾을 수 없습니다. 등록되면 시스템이 자동으로 다시 확인합니다." };
    }
    if (result.status === "NORMAL") {
      return {
        tone: "ok" as const,
        text: result.autoCreatedProductName
          ? `확인됐습니다. '${result.autoCreatedProductName}' 상품을 만들어 재고에 넣었습니다.`
          : "확인됐습니다. 재고에 들어갔습니다.",
      };
    }
    if (result.status === "PENDING_MAPPING") {
      return { tone: "warn" as const, text: "번호는 확인됐지만 상품을 정하지 못했습니다. 상품을 지정해 주세요." };
    }

    return { tone: "warn" as const, text: "바꾼 번호도 이력에서 찾을 수 없습니다. 번호를 다시 확인해 주세요." };
  };

  const run = async (nextTraceNo: string) => {
    setBusy(true);
    setMessage(null);

    let result = await replaceScanTraceNoAction(scanId, nextTraceNo);

    // 같은 무게로 이미 찍힌 박스와 겹치면 서버가 묻는다 — 다른 박스가 맞을 때만 계속한다.
    if (result.success && result.data && "duplicate" in result.data) {
      const ok = window.confirm(
        `이 번호로 ${result.data.duplicate.lastScannedAt}에 같은 무게의 박스가 이미 찍혀 있습니다.\n\n같은 박스를 두 번 넣는 게 아니라 다른 박스가 맞나요?`
      );

      if (!ok) {
        setBusy(false);

        return;
      }

      result = await replaceScanTraceNoAction(scanId, nextTraceNo, true);
    }

    setBusy(false);

    if (!result.success || !result.data || "duplicate" in result.data) {
      setMessage({ tone: "error", text: result.error ?? "처리하지 못했습니다." });

      return;
    }

    setMessage(describe(result.data));
    setEditing(false);
    router.refresh();
  };

  const linkStyle: React.CSSProperties = {
    border: "none",
    background: "none",
    color: "#1d4ed8",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
  };
  const colors = { ok: "#065f46", warn: "#92400e", error: "#991b1b" } as const;

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
      {!editing ? (
        <>
          <button type="button" disabled={busy} onClick={() => setEditing(true)} style={linkStyle}>
            번호 바꾸기
          </button>
          <button type="button" disabled={busy} onClick={() => void run(traceNo)} style={linkStyle}>
            {busy ? "조회 중…" : "다시 조회"}
          </button>
        </>
      ) : (
        <>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value.trim().toUpperCase())}
            inputMode="numeric"
            aria-label="바로잡을 이력번호"
            style={{
              border: "1px solid #93c5fd",
              borderRadius: "6px",
              padding: compact ? "4px 6px" : "6px 8px",
              fontSize: "12px",
              fontFamily: "monospace",
              width: "150px",
            }}
          />
          <button type="button" disabled={busy || !value} onClick={() => void run(value)} style={linkStyle}>
            {busy ? "조회 중…" : "확인"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setValue(traceNo);
            }}
            style={{ ...linkStyle, color: "#64748b" }}
          >
            취소
          </button>
        </>
      )}
      {message ? <span style={{ fontSize: "12px", color: colors[message.tone] }}>{message.text}</span> : null}
    </span>
  );
}
