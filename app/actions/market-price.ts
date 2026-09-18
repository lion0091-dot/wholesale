"use server";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/invite";
import type { MarketPriceSpecies } from "@/lib/market-price/kape-client";

export interface MarketPriceSnapshotRow {
  species: MarketPriceSpecies;
  grade: string;
  pricePerKg: number;
  /** YYYY-MM-DD */
  snapshotDate: string;
}

/**
 * 상품 등록/수정 화면의 시세 참고 위젯이 쓰는 조회.
 * 매일 크론(app/api/cron/market-price-sync)이 채워둔 캐시에서 가장 최근 스냅샷
 * 날짜 하나만 읽는다 — 실시간으로 KAPE API를 직접 호출하지 않는다.
 *
 * market_price_snapshots는 authenticated 전체에 SELECT RLS가 열려 있어(플랫폼 공용
 * 참고 데이터, 업체별 구분 없음) 일반 세션 클라이언트로 충분하고 별도 권한 체크가
 * 필요 없다.
 */
export async function getLatestMarketPricesAction(): Promise<ActionResult<MarketPriceSnapshotRow[]>> {
  try {
    const supabase = await createClient();

    const { data: latest, error: latestError } = await supabase
      .from("market_price_snapshots")
      .select("snapshot_date")
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) {
      return { success: false, error: latestError.message };
    }

    if (!latest) {
      return { success: true, data: [] };
    }

    const { data, error } = await supabase
      .from("market_price_snapshots")
      .select("species, grade, price_per_kg, snapshot_date")
      .eq("snapshot_date", latest.snapshot_date as string)
      .order("species", { ascending: true })
      .order("price_per_kg", { ascending: false });

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: true,
      data: (data ?? []).map((row) => ({
        species: row.species as MarketPriceSpecies,
        grade: row.grade as string,
        pricePerKg: Number(row.price_per_kg),
        snapshotDate: row.snapshot_date as string,
      })),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "시세 조회 중 오류가 발생했습니다.",
    };
  }
}
