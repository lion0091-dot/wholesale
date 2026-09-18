"use client";

import { useEffect, useState } from "react";
import { getLatestMarketPricesAction, type MarketPriceSnapshotRow } from "@/app/actions/market-price";
import type { MarketPriceSpecies } from "@/lib/market-price/kape-client";

/** 상품 카테고리(축종) 표기 -> 시세 API가 다루는 축종 키. 그 외 축종은 시세 데이터가 없다. */
const CATEGORY_TO_SPECIES: Record<string, MarketPriceSpecies> = {
  소: "cattle",
  돼지: "pig",
};

/**
 * KAPE 응답은 등급을 한 리스트에 다 섞어서 준다. 소는 서로 다른 두 기준(육질/육량)이
 * 같은 필드에 같이 나와서(예: "1++"와 "A"가 나란히) 그대로 나열하면 뭐가 뭔지 헷갈린다.
 * 여기서 그룹을 나눠 라벨을 붙인다.
 */
type GradeGroup = "quality" | "yield" | "other" | "aggregate";

const GROUP_LABEL: Record<MarketPriceSpecies, Partial<Record<GradeGroup, string>>> = {
  cattle: { quality: "육질등급", yield: "육량등급", other: "기타", aggregate: "집계" },
  pig: { quality: "등급", other: "기타", aggregate: "집계" },
};

const GROUP_ORDER: GradeGroup[] = ["quality", "yield", "other", "aggregate"];

const CATTLE_QUALITY_GRADES = new Set(["1++", "1+", "1", "2", "3"]);
const CATTLE_YIELD_GRADES = new Set(["A", "B", "C", "D"]);
const AGGREGATE_GRADES = new Set(["평균", "등외제외"]);

function classifyGrade(species: MarketPriceSpecies, grade: string): GradeGroup {
  if (AGGREGATE_GRADES.has(grade)) return "aggregate";

  if (species === "cattle") {
    if (CATTLE_QUALITY_GRADES.has(grade)) return "quality";
    if (CATTLE_YIELD_GRADES.has(grade)) return "yield";
    return "other";
  }

  // 돼지는 이중 체계가 없다 — 1+/1/2/등외는 그대로 "등급", 모돈만 별도.
  return grade === "모돈" ? "other" : "quality";
}

function formatWon(amount: number): string {
  return `${Math.round(amount).toLocaleString("ko-KR")}원`;
}

function formatSnapshotDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

interface MarketPriceWidgetProps {
  /** 상품 등록 폼에서 선택된 카테고리(축종) 표기, 예: "소", "돼지", "닭/오리" */
  category: string;
}

/**
 * 오늘 전국 평균 경락가 참고 위젯 — 원매가(매입 원가) 참고란 옆에서 시세와
 * 눈으로 비교할 수 있게 보여준다. 크론(app/api/cron/market-price-sync)이 채워둔
 * 캐시(market_price_snapshots)를 읽을 뿐, 상품 SKU와 강제로 매핑하지 않는다.
 */
export function MarketPriceWidget({ category }: MarketPriceWidgetProps) {
  const [rows, setRows] = useState<MarketPriceSnapshotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getLatestMarketPricesAction().then((result) => {
      if (cancelled) return;

      if (result.success) {
        setRows(result.data ?? []);
      } else {
        setError(result.error ?? "시세를 불러오지 못했습니다.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const species = CATEGORY_TO_SPECIES[category];

  // 소/돼지 외 축종은 시세 데이터 자체가 없어 위젯을 아예 숨긴다.
  if (!species) {
    return null;
  }

  const speciesRows = (rows ?? []).filter((row) => row.species === species);

  return (
    <div
      style={{
        marginTop: "10px",
        backgroundColor: "#eff6ff",
        border: "1px solid #bfdbfe",
        borderRadius: "8px",
        padding: "12px 14px",
      }}
    >
      <div style={{ fontSize: "11px", fontWeight: 700, color: "#1e40af" }}>
        📊 오늘 전국 평균 경락가 (참고용)
      </div>

      {error && (
        <p style={{ fontSize: "12px", color: "#b91c1c", marginTop: "6px" }}>{error}</p>
      )}

      {!error && rows === null && (
        <p style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>불러오는 중...</p>
      )}

      {!error && rows !== null && speciesRows.length === 0 && (
        <p style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>
          아직 시세 데이터가 없습니다. 축산물품질평가원 경락가격 API 키(KAPE_MARKET_PRICE_API_KEY)를
          서버 환경변수에 등록하면 표시됩니다(플랫폼 운영자 설정 필요). 이미 등록돼 있다면 오늘 자료가
          아직 안 올라왔을 수 있습니다.
        </p>
      )}

      {speciesRows.length > 0 && (
        <>
          {GROUP_ORDER.map((group) => {
            const groupLabel = GROUP_LABEL[species][group];
            const groupRows = speciesRows.filter((row) => classifyGrade(species, row.grade) === group);

            if (!groupLabel || groupRows.length === 0) return null;

            return (
              <div key={group} style={{ marginTop: "8px" }}>
                <div style={{ fontSize: "10px", fontWeight: 700, color: "#3b82f6" }}>{groupLabel}</div>
                <ul
                  style={{
                    listStyle: "none",
                    margin: "4px 0 0",
                    padding: 0,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "6px",
                  }}
                >
                  {groupRows.map((row) => (
                    <li
                      key={row.grade}
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "#1e3a8a",
                        backgroundColor: "#dbeafe",
                        borderRadius: "6px",
                        padding: "4px 8px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.grade} {formatWon(row.pricePerKg)}/kg
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p style={{ fontSize: "11px", color: "#64748b", marginTop: "8px" }}>
            {formatSnapshotDate(speciesRows[0].snapshotDate)} 기준 · 축산물품질평가원 공공데이터
          </p>
        </>
      )}
    </div>
  );
}
