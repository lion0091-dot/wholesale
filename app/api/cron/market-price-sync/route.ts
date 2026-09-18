import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import {
  fetchCattleAuctionPrices,
  fetchPigAuctionPrices,
  isKapeMarketPriceConfigured,
  type MarketPriceRow,
} from "@/lib/market-price/kape-client";

/**
 * 하루 1회(vercel.json의 crons) KAPE 축산물 경락가격 API를 호출해
 * market_price_snapshots에 캐싱하는 배치. Vercel Hobby 플랜은 크론 최소 주기가
 * 1일이라 실시간 조회 대신 이 캐시를 상품 등록 화면 위젯이 읽는다.
 *
 * service_role로 쓴다 — 이 테이블엔 authenticated용 SELECT 정책만 있고 쓰기 정책이
 * 없어서(market_price_snapshots 마이그레이션 참고) 일반 세션 클라이언트로는 못 쓴다.
 */
export const runtime = "nodejs";

/** KST(Asia/Seoul) 기준 오늘 날짜를 YYYYMMDD로 반환한다. 서버 타임존과 무관하게 항상 KST 기준. */
function todayYmdInSeoul(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${map.year}${map.month}${map.day}`;
}

function ymdToIsoDate(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

interface SpeciesSyncResult {
  species: string;
  status: "ok" | "skipped" | "error";
  rowCount?: number;
  message?: string;
}

async function syncSpecies(
  label: string,
  fetcher: () => Promise<MarketPriceRow[] | null>,
  supabase: ReturnType<typeof createServiceRoleClient>,
  snapshotDateIso: string
): Promise<SpeciesSyncResult> {
  let rows: MarketPriceRow[] | null;

  try {
    rows = await fetcher();
  } catch (error) {
    return {
      species: label,
      status: "error",
      message: error instanceof Error ? error.message : "알 수 없는 오류",
    };
  }

  if (rows === null) {
    return { species: label, status: "skipped", message: "KAPE_MARKET_PRICE_API_KEY 미설정" };
  }

  if (rows.length === 0) {
    return { species: label, status: "ok", rowCount: 0, message: "응답에 등급별 행이 없음" };
  }

  const { error } = await supabase!.from("market_price_snapshots").upsert(
    rows.map((row) => ({
      species: row.species,
      grade: row.grade,
      region: "national",
      price_per_kg: row.pricePerKg,
      unit_count: row.unitCount,
      snapshot_date: snapshotDateIso,
      source: row.source,
    })),
    { onConflict: "species,grade,region,snapshot_date" }
  );

  if (error) {
    return { species: label, status: "error", message: error.message };
  }

  return { species: label, status: "ok", rowCount: rows.length };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const authHeader = request.headers.get("authorization");

    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  if (!isKapeMarketPriceConfigured()) {
    return NextResponse.json({ skipped: true, reason: "KAPE_MARKET_PRICE_API_KEY 미설정" });
  }

  const supabase = createServiceRoleClient();

  if (!supabase) {
    return NextResponse.json({ error: "service_role 클라이언트를 생성할 수 없습니다." }, { status: 500 });
  }

  const dateYmd = todayYmdInSeoul();
  const snapshotDateIso = ymdToIsoDate(dateYmd);

  const results = await Promise.all([
    syncSpecies("cattle", () => fetchCattleAuctionPrices(dateYmd), supabase, snapshotDateIso),
    syncSpecies("pig", () => fetchPigAuctionPrices(dateYmd), supabase, snapshotDateIso),
  ]);

  // 축종 하나가 실패해도 다른 쪽 캐싱은 이미 반영됐으니 200으로 응답하고
  // 실패 내역은 body의 results로만 남긴다(크론 모니터링에서 오탐 알림 방지).
  return NextResponse.json({ snapshotDate: snapshotDateIso, results });
}
