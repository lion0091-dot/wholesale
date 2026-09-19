/**
 * 관리자용 플랫폼 전체 통계 — 기존 데이터만으로 재구성한다. 새 스키마 없이
 * wholesalers.created_at(가입 시점)과 orders.ordered_at(실발주 이력)만 사용하므로
 * 언제든 임의 과거 구간을 다시 계산할 수 있다.
 *
 * 잠긴 단순화 결정: 이벤트 할인·일할 계산은 과거 달 재구성에는 반영하지 않는다(그 두
 * 기능 자체가 최근에 생겼고, 과거 시점 기준을 되짚기엔 근거 데이터가 마땅치 않다) —
 * "구간별 누진 단가 기준 정가"만 보여준다.
 *
 * 구독료 추이(월별 청구액 합계)는 애초에 월 단위로 청구되는 값이라 항상 월 단위로만
 * 조회한다(getMonthlyFeeStats). 구독자 추이(누적 가입 공급사 수)는 가입이 하루
 * 단위로 들쭉날쭉해서 짧은 기간은 일 단위가, 긴 기간은 월 단위가 더 보기 좋을 수
 * 있어 화면에서 단위를 고를 수 있게 둘 다 제공한다(getDailySubscriberStats /
 * getMonthlySubscriberStats).
 */

import type { createClient } from "@/lib/supabase/server";
import { computeMonthlyFee } from "@/lib/supplier/billing";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toKstDate(isoUtc: string): Date {
  return new Date(new Date(isoUtc).getTime() + KST_OFFSET_MS);
}

function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dayKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** 'YYYY-MM'의 KST 달력 월 경계를 UTC ISO로. lib/supplier/billed-retailers.ts와 같은 원칙. */
function monthRangeUtc(monthKey: string): { startUtc: string; endUtc: string } {
  const [year, month] = monthKey.split("-").map(Number);
  const startKst = Date.UTC(year, month - 1, 1, 0, 0, 0);
  const endKst = Date.UTC(year, month, 1, 0, 0, 0);

  return {
    startUtc: new Date(startKst - KST_OFFSET_MS).toISOString(),
    endUtc: new Date(endKst - KST_OFFSET_MS).toISOString(),
  };
}

/** 'YYYY-MM-DD'의 KST 달력 일 경계를 UTC ISO로. */
function dayRangeEndUtc(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const endKst = Date.UTC(year, month - 1, day + 1, 0, 0, 0);

  return new Date(endKst - KST_OFFSET_MS).toISOString();
}

/** startMonth~endMonth(둘 다 'YYYY-MM', 포함) 사이 모든 월 키를 오름차순으로. */
export function enumerateMonthKeys(startMonth: string, endMonth: string): string[] {
  const [startYear, startMonthNum] = startMonth.split("-").map(Number);
  const [endYear, endMonthNum] = endMonth.split("-").map(Number);
  const keys: string[] = [];
  let year = startYear;
  let month = startMonthNum;

  while (year < endYear || (year === endYear && month <= endMonthNum)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return keys;
}

/** startDay~endDay(둘 다 'YYYY-MM-DD', 포함) 사이 모든 일 키를 오름차순으로. */
export function enumerateDayKeys(startDay: string, endDay: string): string[] {
  const keys: string[] = [];
  let cursor = startDay;

  while (cursor <= endDay) {
    keys.push(cursor);

    const [year, month, day] = cursor.split("-").map(Number);
    cursor = dayKeyOf(new Date(Date.UTC(year, month - 1, day + 1)));
  }

  return keys;
}

export interface DailySubscriberStat {
  /** 'YYYY-MM-DD' (KST) */
  date: string;
  /** 이 날짜 말 기준 누적 가입 공급사 수 */
  cumulativeSupplierCount: number;
}

export async function getDailySubscriberStats(
  supabase: SupabaseServerClient,
  startDay: string,
  endDay: string
): Promise<DailySubscriberStat[]> {
  const dayKeys = enumerateDayKeys(startDay, endDay);

  if (dayKeys.length === 0) {
    return [];
  }

  const rangeEndUtc = dayRangeEndUtc(dayKeys[dayKeys.length - 1]);

  const { data: wholesalers } = await supabase
    .from("wholesalers")
    .select("created_at")
    .lt("created_at", rangeEndUtc);

  const createdDayKeys = ((wholesalers ?? []) as Array<{ created_at: string }>)
    .map((row) => dayKeyOf(toKstDate(row.created_at)))
    .sort();

  let cumulative = 0;
  let cursor = 0;

  return dayKeys.map((key) => {
    while (cursor < createdDayKeys.length && createdDayKeys[cursor] <= key) {
      cumulative += 1;
      cursor += 1;
    }

    return { date: key, cumulativeSupplierCount: cumulative };
  });
}

export interface MonthlySubscriberStat {
  /** 'YYYY-MM' (KST) */
  month: string;
  /** 이 달 말 기준 누적 가입 공급사 수 */
  cumulativeSupplierCount: number;
}

/** getDailySubscriberStats와 같은 로직을 월 단위로. 긴 구간을 볼 때(예: 1년 이상)
 *  일 단위는 점이 너무 많아 추이가 잘 안 보이므로 월 단위 옵션도 제공한다. */
export async function getMonthlySubscriberStats(
  supabase: SupabaseServerClient,
  startMonth: string,
  endMonth: string
): Promise<MonthlySubscriberStat[]> {
  const monthKeys = enumerateMonthKeys(startMonth, endMonth);

  if (monthKeys.length === 0) {
    return [];
  }

  const rangeEndUtc = monthRangeUtc(monthKeys[monthKeys.length - 1]).endUtc;

  const { data: wholesalers } = await supabase
    .from("wholesalers")
    .select("created_at")
    .lt("created_at", rangeEndUtc);

  const createdMonthKeys = ((wholesalers ?? []) as Array<{ created_at: string }>)
    .map((row) => monthKeyOf(toKstDate(row.created_at)))
    .sort();

  let cumulative = 0;
  let cursor = 0;

  return monthKeys.map((key) => {
    while (cursor < createdMonthKeys.length && createdMonthKeys[cursor] <= key) {
      cumulative += 1;
      cursor += 1;
    }

    return { month: key, cumulativeSupplierCount: cumulative };
  });
}

export interface MonthlyFeeStat {
  /** 'YYYY-MM' (KST) */
  month: string;
  /** 이 달 전체 공급사 구독료 합계(구간별 누진 단가 기준 정가, 할인·일할 미반영) */
  totalMonthlyFee: number;
}

export async function getMonthlyFeeStats(
  supabase: SupabaseServerClient,
  startMonth: string,
  endMonth: string
): Promise<MonthlyFeeStat[]> {
  const monthKeys = enumerateMonthKeys(startMonth, endMonth);

  if (monthKeys.length === 0) {
    return [];
  }

  const rangeStartUtc = monthRangeUtc(monthKeys[0]).startUtc;
  const rangeEndUtc = monthRangeUtc(monthKeys[monthKeys.length - 1]).endUtc;

  const { data: orders } = await supabase
    .from("orders")
    .select("wholesaler_id, retailer_id, ordered_at")
    .neq("status", "cancelled")
    .gte("ordered_at", rangeStartUtc)
    .lt("ordered_at", rangeEndUtc);

  // 월 → (wholesaler_id → 그 달에 실발주한 거래처 id 집합)
  const billedRetailersByMonth = new Map<string, Map<string, Set<string>>>();

  for (const order of (orders ?? []) as Array<{
    wholesaler_id: string;
    retailer_id: string;
    ordered_at: string;
  }>) {
    const key = monthKeyOf(toKstDate(order.ordered_at));

    if (!billedRetailersByMonth.has(key)) {
      billedRetailersByMonth.set(key, new Map());
    }

    const byWholesaler = billedRetailersByMonth.get(key)!;

    if (!byWholesaler.has(order.wholesaler_id)) {
      byWholesaler.set(order.wholesaler_id, new Set());
    }

    byWholesaler.get(order.wholesaler_id)!.add(order.retailer_id);
  }

  return monthKeys.map((key) => {
    const byWholesaler = billedRetailersByMonth.get(key);
    const totalMonthlyFee = byWholesaler
      ? Array.from(byWholesaler.values()).reduce(
          (sum, retailerSet) => sum + computeMonthlyFee(retailerSet.size),
          0
        )
      : 0;

    return { month: key, totalMonthlyFee };
  });
}
