"use client";

import { useState } from "react";
import type { LineAssignment, ReceivingPolicy, ToleranceMode, UnlistedItemPolicy } from "@/lib/receiving-policy/policy";
import { saveReceivingPolicyAction } from "./actions";

const cardStyle: React.CSSProperties = { border: "1px solid #e2e8f0", borderRadius: "12px", padding: "14px", backgroundColor: "#fff", display: "grid", gap: "8px" };
const titleStyle: React.CSSProperties = { fontSize: "14px", fontWeight: 800, color: "#0f172a", margin: 0 };
const hintStyle: React.CSSProperties = { fontSize: "12px", color: "#64748b", margin: 0 };
const optionStyle: React.CSSProperties = { display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px", color: "#334155" };
const fieldStyle: React.CSSProperties = { width: "110px", padding: "7px 9px", fontSize: "13px", border: "1px solid #cbd5e1", borderRadius: "6px", boxSizing: "border-box" };
const primaryButtonStyle: React.CSSProperties = { padding: "9px 18px", fontSize: "13px", fontWeight: 700, border: "none", borderRadius: "8px", backgroundColor: "#0f172a", color: "#fff", cursor: "pointer", justifySelf: "start" };

interface Props {
  initial: ReceivingPolicy;
  canManage: boolean;
}

export function ReceivingPolicyForm({ initial, canManage }: Props) {
  const [mode, setMode] = useState<ToleranceMode>(initial.overToleranceMode);
  const [value, setValue] = useState(String(initial.overToleranceValue));
  const [unlisted, setUnlisted] = useState<UnlistedItemPolicy>(initial.unlistedItemPolicy);
  const [assignment, setAssignment] = useState<LineAssignment>(initial.lineAssignment);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const numeric = Number.parseFloat(value.replace(/,/g, ""));
  const example =
    !Number.isFinite(numeric) || numeric <= 0
      ? "발주한 양을 넘게 받지 않습니다. (예: 발주 50kg이면 50kg까지)"
      : mode === "PERCENT"
        ? `예: 발주 50kg이면 ${Number((50 * (1 + numeric / 100)).toFixed(2))}kg까지 받습니다.`
        : `예: 발주 50kg이면 ${Number((50 + numeric).toFixed(2))}kg까지 받습니다.`;

  const save = async () => {
    setBusy(true);
    setMessage(null);

    const result = await saveReceivingPolicyAction({ overToleranceMode: mode, overToleranceValue: value, unlistedItemPolicy: unlisted, lineAssignment: assignment });

    setBusy(false);
    setMessage(result.success ? { ok: true, text: "저장했습니다." } : { ok: false, text: result.error ?? "저장하지 못했습니다." });
  };

  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <section style={cardStyle}>
        <h2 style={titleStyle}>발주보다 더 온 물건</h2>
        <p style={hintStyle}>같은 거래처에 낸 열린 발주서 합계보다 얼마까지 더 받아도 되는지 정합니다.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
          <label style={optionStyle}>
            <input type="radio" name="mode" checked={mode === "PERCENT"} disabled={!canManage} onChange={() => setMode("PERCENT")} />
            퍼센트(%)
          </label>
          <label style={optionStyle}>
            <input type="radio" name="mode" checked={mode === "KG"} disabled={!canManage} onChange={() => setMode("KG")} />
            킬로그램(kg)
          </label>
          <input aria-label="허용 오차" inputMode="decimal" value={value} disabled={!canManage} onChange={(event) => setValue(event.target.value)} style={fieldStyle} autoComplete="off" />
          <span style={{ fontSize: "13px", color: "#334155" }}>{mode === "PERCENT" ? "%" : "kg"}</span>
        </div>
        <p style={hintStyle}>{example}</p>
      </section>

      <section style={cardStyle}>
        <h2 style={titleStyle}>발주서에 없는 물건이 왔을 때</h2>
        <label style={optionStyle}>
          <input type="radio" name="unlisted" checked={unlisted === "REJECT"} disabled={!canManage} onChange={() => setUnlisted("REJECT")} />
          받지 않습니다.
        </label>
        <label style={optionStyle}>
          <input type="radio" name="unlisted" checked={unlisted === "HOLD"} disabled={!canManage} onChange={() => setUnlisted("HOLD")} />
          일단 받고, 사무실이 확인할 수 있게 따로 표시해 둡니다.
        </label>
      </section>

      <section style={cardStyle}>
        <h2 style={titleStyle}>같은 물건이 여러 발주서에 걸릴 때</h2>
        <p style={hintStyle}>어느 발주서에 붙일지 정합니다. 해당하는 발주서가 하나뿐이면 항상 자동으로 붙습니다.</p>
        <label style={optionStyle}>
          <input type="radio" name="assignment" checked={assignment === "OFFICE"} disabled={!canManage} onChange={() => setAssignment("OFFICE")} />
          사무실이 직접 고릅니다.
        </label>
        <label style={optionStyle}>
          <input type="radio" name="assignment" checked={assignment === "OLDEST_FIRST"} disabled={!canManage} onChange={() => setAssignment("OLDEST_FIRST")} />
          오래된 발주서부터 자동으로 붙입니다.
        </label>
      </section>

      {canManage ? (
        <>
          <button type="button" style={primaryButtonStyle} disabled={busy} onClick={() => void save()}>
            {busy ? "저장 중..." : "저장"}
          </button>
          {message && (
            <p role={message.ok ? "status" : "alert"} style={{ margin: 0, fontSize: "13px", color: message.ok ? "#166534" : "#b91c1c" }}>
              {message.text}
            </p>
          )}
        </>
      ) : (
        <p style={hintStyle}>입고 기준은 사장님·매니저만 바꿀 수 있습니다. 직원은 조회만 됩니다.</p>
      )}
    </div>
  );
}
