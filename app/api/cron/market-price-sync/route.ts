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

/** KST(Asia/Seoul) 기준 N일 전 날짜를 YYYYMMDD로 반환한다. 서버 타임존과 무관하게 항상 KST 기준. */
function ymdDaysAgoInSeoul(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

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
  snapshotDate?: string;
  message?: string;
}

/** 주말/공휴일엔 경매가 없어 당일 조회가 가격 없는 등급코드표만 돌려준다 — 최근 실제 경매일까지 거슬러 올라간다. */
const MAX_LOOKBACK_DAYS = 6;

async function syncSpecies(
  label: string,
  fetcher: (dateYmd: string) => Promise<MarketPriceRow[] | null>,
  supabase: ReturnType<typeof createServiceRoleClient>
): Promise<SpeciesSyncResult> {
  for (let offset = 0; offset <= MAX_LOOKBACK_DAYS; offset++) {
    const dateYmd = ymdDaysAgoInSeoul(offset);
    let rows: MarketPriceRow[] | null;

    try {
      rows = await fetcher(dateYmd);
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
      continue;
    }

    const snapshotDateIso = ymdToIsoDate(dateYmd);

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

    return {
      species: label,
      status: "ok",
      rowCount: rows.length,
      snapshotDate: snapshotDateIso,
      message: offset > 0 ? `당일 데이터 없어 ${offset}일 전(최근 경매일) 데이터 사용` : undefined,
    };
  }

  return { species: label, status: "ok", rowCount: 0, message: `최근 ${MAX_LOOKBACK_DAYS}일간 경매 데이터 없음` };
}

export async function GET(request: NextRequest) {
  // CRON_SECRET이 없으면 누구나 호출할 수 있는 상태라 실행 자체를 거부한다(2026-09-24 점검 3).
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET 환경변수가 설정되지 않아 크론 실행을 거부합니다. Vercel 환경변수에 등록해주세요." },
      { status: 500 }
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isKapeMarketPriceConfigured()) {
    return NextResponse.json({ skipped: true, reason: "KAPE_MARKET_PRICE_API_KEY 미설정" });
  }

  const supabase = createServiceRoleClient();

  if (!supabase) {
    return NextResponse.json({ error: "service_role 클라이언트를 생성할 수 없습니다." }, { status: 500 });
  }

  const results = await Promise.all([
    syncSpecies("cattle", fetchCattleAuctionPrices, supabase),
    syncSpecies("pig", fetchPigAuctionPrices, supabase),
  ]);

  // 축종 하나가 실패해도 다른 쪽 캐싱은 이미 반영됐으니 200으로 응답하고
  // 실패 내역은 body의 results로만 남긴다(크론 모니터링에서 오탐 알림 방지).
  return NextResponse.json({ results });
}
