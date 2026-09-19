import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import {
  getDailySubscriberStats,
  getMonthlyFeeStats,
  type DailySubscriberStat,
  type MonthlyFeeStat,
} from "@/lib/supplier/platform-stats";
import { AdminTrendChart } from "@/components/admin-trend-chart";
import { AdminDateRangeFilter } from "@/components/admin-date-range-filter";
import { AdminMonthRangeFilter } from "@/components/admin-month-range-filter";
import { AdminNav } from "@/components/admin-nav";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function todayDateStringKst(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDateString(dateStr: string, daysDelta: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + daysDelta));

  return date.toISOString().slice(0, 10);
}

function currentMonthKeyKst(): string {
  return todayDateStringKst().slice(0, 7);
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 데모 모드(Supabase 미설정) 시연용 30일 구독자 샘플 데이터. */
function buildDemoSubscriberStats(fromDay: string, toDay: string): DailySubscriberStat[] {
  const days: string[] = [];
  let cursor = fromDay;

  while (cursor <= toDay) {
    days.push(cursor);
    cursor = shiftDateString(cursor, 1);
  }

  let cumulative = 5;

  return days.map((date, index) => {
    if (index > 0 && index % 4 === 0) {
      cumulative += 1;
    }

    return { date, cumulativeSupplierCount: cumulative };
  });
}

/** 데모 모드(Supabase 미설정) 시연용 6개월 구독료 샘플 데이터. */
function buildDemoFeeStats(fromMonth: string, toMonth: string): MonthlyFeeStat[] {
  const months: string[] = [];
  let cursor = fromMonth;

  while (cursor <= toMonth) {
    months.push(cursor);
    cursor = shiftMonthKey(cursor, 1);
  }

  return months.map((month, index) => ({
    month,
    totalMonthlyFee: (index + 4) * 5 * 5000 + index * 20000,
  }));
}

interface PageProps {
  searchParams: Promise<{
    subFrom?: string;
    subTo?: string;
    feeFrom?: string;
    feeTo?: string;
  }>;
}

export default async function AdminStatsPage({ searchParams }: PageProps) {
  const isConfigured = isSupabaseConfigured();

  if (isConfigured && !(await isSuperAdminSession())) {
    redirect("/login?next=/admin/stats");
  }

  const params = await searchParams;
  const today = todayDateStringKst();
  const currentMonth = currentMonthKeyKst();

  // 구독자 추이 — 가입이 하루 단위로 들쭉날쭉해서 일 단위 조회가 자연스럽다. 기본 최근 30일.
  const defaultSubFrom = shiftDateString(today, -30);
  const subFrom = params.subFrom && DATE_PATTERN.test(params.subFrom) ? params.subFrom : defaultSubFrom;
  const subTo = params.subTo && DATE_PATTERN.test(params.subTo) ? params.subTo : today;
  const [rangeSubFrom, rangeSubTo] = subFrom <= subTo ? [subFrom, subTo] : [subTo, subFrom];

  // 구독료 추이 — 매달 한 번 청구되는 값이라 월 단위 조회가 자연스럽다. 기본 최근 6개월.
  const defaultFeeFrom = shiftMonthKey(currentMonth, -5);
  const feeFrom = params.feeFrom && MONTH_PATTERN.test(params.feeFrom) ? params.feeFrom : defaultFeeFrom;
  const feeTo = params.feeTo && MONTH_PATTERN.test(params.feeTo) ? params.feeTo : currentMonth;
  const [rangeFeeFrom, rangeFeeTo] = feeFrom <= feeTo ? [feeFrom, feeTo] : [feeTo, feeFrom];

  let subscriberStats: DailySubscriberStat[];
  let feeStats: MonthlyFeeStat[];

  if (isConfigured) {
    const supabase = await createClient();
    [subscriberStats, feeStats] = await Promise.all([
      getDailySubscriberStats(supabase, rangeSubFrom, rangeSubTo),
      getMonthlyFeeStats(supabase, rangeFeeFrom, rangeFeeTo),
    ]);
  } else {
    subscriberStats = buildDemoSubscriberStats(rangeSubFrom, rangeSubTo);
    feeStats = buildDemoFeeStats(rangeFeeFrom, rangeFeeTo);
  }

  const subscriberPoints = subscriberStats.map((point) => ({ label: point.date, value: point.cumulativeSupplierCount }));
  const feePoints = feeStats.map((point) => ({ label: point.month, value: point.totalMonthlyFee }));

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "24px" }}>
        <AdminNav />
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px", marginBottom: "8px" }}>
          구독자·구독료 추이
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6 }}>
          누적 가입 공급사 수는 일 단위로, 전체 공급사 구독료 합계(구간별 누진 단가 기준
          정가, 이벤트 할인·일할 계산은 반영 안 함)는 월 단위로 각각 조회합니다.
        </p>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <AdminDateRangeFilter
            basePath="/admin/stats"
            from={rangeSubFrom}
            to={rangeSubTo}
            fromParam="subFrom"
            toParam="subTo"
            helperText="누적 가입 공급사 수 그래프의 조회 기간(일 단위)"
          />
          <AdminTrendChart
            title="누적 가입 공급사 수"
            points={subscriberPoints}
            color="#b91c1c"
            valueUnit="count"
            granularity="day"
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <AdminMonthRangeFilter
            basePath="/admin/stats"
            from={rangeFeeFrom}
            to={rangeFeeTo}
            fromParam="feeFrom"
            toParam="feeTo"
            helperText="구독료 합계 그래프의 조회 기간(월 단위)"
          />
          <AdminTrendChart
            title="전체 공급사 구독료 합계"
            points={feePoints}
            color="#166534"
            valueUnit="won"
            granularity="month"
          />
        </div>
      </div>
    </main>
  );
}
