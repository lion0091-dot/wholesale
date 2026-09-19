"use client";

import { useState } from "react";

export interface TrendPoint {
  /** X축 표시용 원본 키(예: 'YYYY-MM') */
  label: string;
  value: number;
}

interface AdminTrendChartProps {
  title: string;
  points: TrendPoint[];
  /** 라인/점 색상 */
  color: string;
  /** 값 단위. 'count'는 "곳", 'won'은 "원" 접미사를 붙인다. */
  valueUnit: "count" | "won";
  /** label 형식 — 'month'는 'YYYY-MM', 'day'는 'YYYY-MM-DD'를 받는다. */
  granularity: "month" | "day";
}

/**
 * 서버 컴포넌트(app/admin/stats/page.tsx)가 렌더링하는 화면이라 포매터 함수를 그대로
 * props로 넘길 수 없다(RSC 경계에서 함수는 직렬화 불가) — 문자열 유닛/그래뉼래러티만
 * 받아 여기서 포맷을 결정한다.
 */
function formatLabelByGranularity(label: string, granularity: "month" | "day"): string {
  if (granularity === "day") {
    const [, month, day] = label.split("-");

    return `${Number(month)}/${Number(day)}`;
  }

  const [, month] = label.split("-");

  return `${Number(month)}월`;
}

function formatValueByUnit(value: number, unit: "count" | "won"): string {
  return unit === "won" ? `${value.toLocaleString("ko-KR")}원` : `${value.toLocaleString("ko-KR")}곳`;
}

const WIDTH = 640;
const HEIGHT = 220;
const PADDING = { top: 16, right: 16, bottom: 30, left: 60 };
const GRID_RATIOS = [0, 0.25, 0.5, 0.75, 1];
/** 일 단위 구간은 점이 많아질 수 있어(예: 90일) x축 라벨을 최대 이 개수만 골라 보여준다. */
const MAX_AXIS_LABELS = 8;

/**
 * 의존성 없는 인라인 SVG 점+선 추이 그래프. 단일 시리즈만 다루므로(범례 불필요,
 * 차트 제목이 곧 시리즈 이름) 색은 브랜드 색 하나만 쓴다. 호버 시 툴팁으로 정확한
 * 값을 보여준다.
 */
export function AdminTrendChart({ title, points, color, valueUnit, granularity }: AdminTrendChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const formatValue = (value: number) => formatValueByUnit(value, valueUnit);
  const formatLabel = (label: string) => formatLabelByGranularity(label, granularity);
  const labelStep = Math.max(1, Math.ceil(points.length / MAX_AXIS_LABELS));
  const showAxisLabelAt = (index: number) => index % labelStep === 0 || index === points.length - 1;

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const maxValue = Math.max(...points.map((point) => point.value), 1);

  const xFor = (index: number) =>
    points.length <= 1 ? PADDING.left + plotWidth / 2 : PADDING.left + (plotWidth * index) / (points.length - 1);
  const yFor = (value: number) => PADDING.top + plotHeight - (plotHeight * value) / maxValue;

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(index)} ${yFor(point.value)}`).join(" ");

  return (
    <div style={{ backgroundColor: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "20px" }}>
      <h3 style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a", marginBottom: "12px" }}>{title}</h3>

      {points.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#94a3b8" }}>선택한 기간에 표시할 데이터가 없습니다.</p>
      ) : (
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ width: "100%", height: "auto", display: "block" }}>
            {GRID_RATIOS.map((ratio) => {
              const y = PADDING.top + plotHeight * (1 - ratio);

              return (
                <g key={ratio}>
                  <line x1={PADDING.left} y1={y} x2={WIDTH - PADDING.right} y2={y} stroke="#f1f5f9" strokeWidth={1} />
                  <text x={PADDING.left - 8} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
                    {formatValue(Math.round(maxValue * ratio))}
                  </text>
                </g>
              );
            })}

            <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

            {points.map((point, index) => (
              <g key={point.label}>
                <circle
                  cx={xFor(index)}
                  cy={yFor(point.value)}
                  r={hoverIndex === index ? 6 : 4.5}
                  fill="#ffffff"
                  stroke={color}
                  strokeWidth={2}
                  onMouseEnter={() => setHoverIndex(index)}
                  onMouseLeave={() => setHoverIndex((current) => (current === index ? null : current))}
                  style={{ cursor: "pointer" }}
                />
                {showAxisLabelAt(index) && (
                  <text x={xFor(index)} y={HEIGHT - PADDING.bottom + 18} textAnchor="middle" fontSize="10" fill="#64748b">
                    {formatLabel(point.label)}
                  </text>
                )}
              </g>
            ))}
          </svg>

          {hoverIndex !== null && (
            <div
              style={{
                position: "absolute",
                left: `${(xFor(hoverIndex) / WIDTH) * 100}%`,
                top: `${(yFor(points[hoverIndex].value) / HEIGHT) * 100}%`,
                transform: "translate(-50%, -135%)",
                backgroundColor: "#0f172a",
                color: "#ffffff",
                fontSize: "11px",
                fontWeight: 700,
                padding: "5px 9px",
                borderRadius: "6px",
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}
            >
              {formatLabel(points[hoverIndex].label)} · {formatValue(points[hoverIndex].value)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
