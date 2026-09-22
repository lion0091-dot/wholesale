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

const MARKET_PRICE_SPECIES: MarketPriceSpecies[] = ["cattle", "pig"];

/**
 * 상품 등록/수정 화면의 시세 참고 위젯이 쓰는 조회.
 * 매일 크론(app/api/cron/market-price-sync)이 채워둔 캐시에서 가장 최근 스냅샷을 읽는다
 * — 실시간으로 KAPE API를 직접 호출하지 않는다.
 *
 * 소/돼지 경매는 실제 운영일이 서로 다를 수 있어(예: 주말 경매 유무가 축종마다 다름)
 * "가장 최근 날짜"를 테이블 전체 기준 1개로 잡으면 안 된다 — 그러면 그 날짜에 데이터가
 * 없는 축종은 실제로는 최신 데이터가 있어도 0건으로 보인다. 축종별로 각자의 최신
 * snapshot_date를 따로 구해서 조회한다.
 *
 * market_price_snapshots의 SELECT RLS는 공급사(및 관리자)로 한정돼 있다
 * (20260930000056) — 공공 시세는 공급사의 매입·판매가 판단용이라 고객에게는
 * 노출하지 않는다. 그래서 일반 세션 클라이언트로 조회하면 고객 계정에서는
 * 자동으로 0건이 되고, 별도 권한 체크 코드가 필요 없다.
 */
export async function getLatestMarketPricesAction(): Promise<ActionResult<MarketPriceSnapshotRow[]>> {
  try {
    const supabase = await createClient();

    const perSpecies = await Promise.all(
      MARKET_PRICE_SPECIES.map(async (species): Promise<MarketPriceSnapshotRow[]> => {
        const { data: latest, error: latestError } = await supabase
          .from("market_price_snapshots")
          .select("snapshot_date")
          .eq("species", species)
          .order("snapshot_date", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestError) {
          throw new Error(latestError.message);
        }

        if (!latest) {
          return [];
        }

        const { data, error } = await supabase
          .from("market_price_snapshots")
          .select("species, grade, price_per_kg, snapshot_date")
          .eq("species", species)
          .eq("snapshot_date", latest.snapshot_date as string)
          .order("price_per_kg", { ascending: false });

        if (error) {
          throw new Error(error.message);
        }

        return (data ?? []).map((row) => ({
          species: row.species as MarketPriceSpecies,
          grade: row.grade as string,
          pricePerKg: Number(row.price_per_kg),
          snapshotDate: row.snapshot_date as string,
        }));
      })
    );

    return { success: true, data: perSpecies.flat() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "시세 조회 중 오류가 발생했습니다.",
    };
  }
}
