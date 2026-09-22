import type { MarketPriceSnapshotRow } from "@/app/actions/market-price";
import type { MarketPriceSpecies } from "@/lib/market-price/kape-client";

/**
 * 상품(축종+등급) → 공공 경락가 매칭.
 *
 * 상품관리 목록에서 상품마다 시세를 따로 조회하면 N+1이 된다. 화면을 열 때
 * 최신 스냅샷을 한 번만 읽어 이 맵을 만들고, 상품마다 여기서 찾아 쓴다.
 */

/** products.category(축종 표기) → 시세 API 축종 키. 그 외 축종은 공공 시세가 없다. */
const CATEGORY_TO_SPECIES: Record<string, MarketPriceSpecies> = {
  소: "cattle",
  돼지: "pig",
};

export type MarketPriceIndex = Map<string, MarketPriceSnapshotRow>;

function key(species: MarketPriceSpecies, grade: string): string {
  return `${species}::${grade.trim().toUpperCase()}`;
}

export function buildMarketPriceIndex(rows: MarketPriceSnapshotRow[]): MarketPriceIndex {
  const index: MarketPriceIndex = new Map();

  for (const row of rows) {
    // 같은 등급이 여러 건이면 더 최신 스냅샷을 남긴다.
    const existing = index.get(key(row.species, row.grade));

    if (!existing || existing.snapshotDate < row.snapshotDate) {
      index.set(key(row.species, row.grade), row);
    }
  }

  return index;
}

/**
 * 상품 한 줄에 붙일 공공가를 찾는다.
 * 시세가 없는 축종(닭·오리, 양, 가공육)이거나 등급 미입력이면 null.
 */
export function findMarketPrice(
  index: MarketPriceIndex,
  category: string,
  grade: string | null
): MarketPriceSnapshotRow | null {
  const species = CATEGORY_TO_SPECIES[category];

  if (!species || !grade) {
    return null;
  }

  return index.get(key(species, grade)) ?? null;
}
