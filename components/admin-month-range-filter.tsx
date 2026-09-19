"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface AdminMonthRangeFilterProps {
  basePath: string;
  /** 'YYYY-MM' */
  from: string;
  /** 'YYYY-MM' */
  to: string;
  helperText?: string;
  fromParam?: string;
  toParam?: string;
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
 * 월 단위로만 의미가 있는 지표(구독료처럼 매달 한 번 청구되는 값)용 조회 기간 필터.
 * admin-date-range-filter.tsx(일 단위)와 같은 페이지에 공존할 수 있도록 쿼리
 * 파라미터 이름을 다르게 지정할 수 있다.
 */
export function AdminMonthRangeFilter({
  basePath,
  from,
  to,
  helperText,
  fromParam = "monthFrom",
  toParam = "monthTo",
}: AdminMonthRangeFilterProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set(fromParam, draftFrom);
    nextParams.set(toParam, draftTo);
    router.push(`${basePath}?${nextParams.toString()}`);
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
      <span style={{ fontSize: "12px", fontWeight: 700, color: "#334155" }}>조회 기간(월)</span>
      <input
        type="month"
        value={draftFrom}
        max={draftTo}
        onChange={(event) => setDraftFrom(event.target.value)}
        style={fieldStyle}
      />
      <span style={{ fontSize: "12px", color: "#94a3b8" }}>~</span>
      <input
        type="month"
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
