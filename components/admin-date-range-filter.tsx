"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

interface AdminDateRangeFilterProps {
  basePath: string;
  from: string;
  to: string;
  /** 필터 오른쪽에 붙는 보조 안내 문구(선택) */
  helperText?: string;
}

const fieldStyle: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: "13px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
};

/**
 * 관리자 통계/청구 화면 공용 — 조회 기간을 날짜(일 단위)로 자유롭게 정하는 필터.
 * URL 쿼리(from/to, 'YYYY-MM-DD')로 상태를 유지한다.
 */
export function AdminDateRangeFilter({ basePath, from, to, helperText }: AdminDateRangeFilterProps) {
  const router = useRouter();
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    router.push(`${basePath}?from=${draftFrom}&to=${draftTo}`);
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        padding: "12px 14px",
      }}
    >
      <span style={{ fontSize: "12px", fontWeight: 700, color: "#334155" }}>조회 기간</span>
      <input
        type="date"
        value={draftFrom}
        max={draftTo}
        onChange={(event) => setDraftFrom(event.target.value)}
        style={fieldStyle}
      />
      <span style={{ fontSize: "12px", color: "#94a3b8" }}>~</span>
      <input
        type="date"
        value={draftTo}
        min={draftFrom}
        onChange={(event) => setDraftTo(event.target.value)}
        style={fieldStyle}
      />
      <button
        type="submit"
        style={{
          fontSize: "12px",
          fontWeight: 700,
          color: "#ffffff",
          backgroundColor: "#0f172a",
          border: "none",
          borderRadius: "8px",
          padding: "8px 14px",
          cursor: "pointer",
        }}
      >
        조회
      </button>
      {helperText && <span style={{ fontSize: "11px", color: "#94a3b8" }}>{helperText}</span>}
    </form>
  );
}
