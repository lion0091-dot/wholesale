"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveWeightToleranceAction, type WeightToleranceSettings } from "@/app/actions/weight-tolerance-settings";

/**
 * 전표 무게 허용 오차 설정. 개체번호 줄처럼 "무게로 세는" 줄이 다 왔다고 볼 범위(표기 무게 ±몇 %)를 업체가 정한다.
 * 공급처 표기와 저울이 자주 어긋나면 넓히면 사무실에 남는 전표가 줄어든다. 저장하면 바로 판정에 반영된다.
 */
export function WeightToleranceForm({ initial }: { initial: WeightToleranceSettings }) {
  const router = useRouter();
  const [percent, setPercent] = useState(String(initial.percent));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const handleSave = () => {
    const parsed = Number.parseFloat(percent);

    if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 20) {
      setError("0.5 이상 20 이하의 숫자를 입력해주세요.");
      setSaved(false);
      return;
    }

    setError(null);

    startTransition(async () => {
      const result = await saveWeightToleranceAction(parsed);

      if (!result.success) {
        setError(result.error ?? "저장에 실패했습니다.");
        setSaved(false);
        return;
      }

      setSaved(true);
      router.refresh();
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>전표 무게 허용 오차</div>
        <div
          style={{
            fontSize: "12px",
            color: "#92400e",
            backgroundColor: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: "6px",
            padding: "8px 10px",
            marginTop: "6px",
            lineHeight: 1.6,
          }}
        >
          지금은 이 값을 저장해도 적용되는 곳이 없습니다. 전표를 올려 도착 여부를 대조하던 화면이 없어져서,
          이 값을 읽던 판정 로직도 함께 사라졌습니다.
        </div>
        <div style={{ fontSize: "12px", color: "#64748b", marginTop: "6px", lineHeight: 1.6 }}>
          (예전 설명) 개체번호 줄처럼 무게로 세는 줄은, 찍은 박스 무게의 합이 전표 표기 무게의 이 범위 안이면 다 온 것으로 봤습니다(기본 2%).
          입고 검수 경고(±2%)와는 별개입니다.
        </div>
      </div>

      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: "13px", color: "#475569" }}>±</span>
        <input
          type="text"
          inputMode="decimal"
          value={percent}
          onChange={(event) => {
            setPercent(event.target.value.replace(/[^0-9.]/g, ""));
            setSaved(false);
          }}
          style={{ width: "80px", padding: "9px 11px", fontSize: "14px", border: "1px solid #cbd5e1", borderRadius: "6px" }}
        />
        <span style={{ fontSize: "13px", color: "#475569" }}>%</span>
        <button
          type="button"
          onClick={handleSave}
          disabled={pending}
          style={{
            padding: "9px 16px",
            fontSize: "13px",
            fontWeight: 700,
            borderRadius: "6px",
            border: "none",
            backgroundColor: pending ? "#93c5fd" : "#0f172a",
            color: "#ffffff",
            cursor: pending ? "wait" : "pointer",
          }}
        >
          {pending ? "저장 중..." : "저장"}
        </button>
        {saved ? <span style={{ fontSize: "12px", color: "#065f46" }}>저장했습니다.</span> : null}
      </div>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", lineHeight: 1.6 }}>
          {error}
        </p>
      )}
    </div>
  );
}
