import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { getMonthlyPlatformStats, type MonthlyPlatformStat } from "@/lib/supplier/platform-stats";
import { AdminTrendChart } from "@/components/admin-trend-chart";
import { AdminDateRangeFilter } from "@/components/admin-date-range-filter";
import { AdminNav } from "@/components/admin-nav";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function todayDateStringKst(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDateString(dateStr: string, monthsDelta: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + monthsDelta, day));

  return date.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 'YYYY-MM'(그 날짜가 속한 달). 그래프는 월 단위로 집계되므로 날짜
 *  범위를 고른 뒤 여기서 월 범위로 다시 환산한다. */
function monthKeyOf(dateStr: string): string {
  return dateStr.slice(0, 7);
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 데모 모드(Supabase 미설정) 시연용 6개월 샘플 데이터. */
function buildDemoStats(fromMonth: string, toMonth: string): MonthlyPlatformStat[] {
  const months: string[] = [];
  let cursor = fromMonth;

  while (cursor <= toMonth) {
    months.push(cursor);
    cursor = shiftMonthKey(cursor, 1);
  }

  let cumulative = 5;

  return months.map((month, index) => {
    const newSupplierCount = index === 0 ? 5 : Math.max(0, (index % 3) + 1);
    cumulative += index === 0 ? 0 : newSupplierCount;

    return {
      month,
      newSupplierCount,
      cumulativeSupplierCount: cumulative,
      totalMonthlyFee: cumulative * 4 * 5000 + index * 20000,
    };
  });
}

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function AdminStatsPage({ searchParams }: PageProps) {
  const isConfigured = isSupabaseConfigured();

  if (isConfigured && !(await isSuperAdminSession())) {
    redirect("/login?next=/admin/stats");
  }

  const params = await searchParams;
  const today = todayDateStringKst();
  const defaultFrom = shiftDateString(today, -6);

  const from = params.from && DATE_PATTERN.test(params.from) ? params.from : defaultFrom;
  const to = params.to && DATE_PATTERN.test(params.to) ? params.to : today;
  const [rangeFrom, rangeTo] = from <= to ? [from, to] : [to, from];
  const [rangeFromMonth, rangeToMonth] = [monthKeyOf(rangeFrom), monthKeyOf(rangeTo)];

  let stats: MonthlyPlatformStat[];

  if (isConfigured) {
    const supabase = await createClient();
    stats = await getMonthlyPlatformStats(supabase, rangeFromMonth, rangeToMonth);
  } else {
    stats = buildDemoStats(rangeFromMonth, rangeToMonth);
  }

  const subscriberPoints = stats.map((point) => ({ label: point.month, value: point.cumulativeSupplierCount }));
  const feePoints = stats.map((point) => ({ label: point.month, value: point.totalMonthlyFee }));

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "24px" }}>
        <AdminNav />
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px", marginBottom: "8px" }}>
          월별 구독자·구독료 추이
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6 }}>
          누적 가입 공급사 수와 전체 공급사 구독료 합계(구간별 누진 단가 기준 정가, 이벤트
          할인·일할 계산은 반영 안 함)를 월별로 보여줍니다.
        </p>
      </header>

      <div style={{ marginBottom: "20px" }}>
        <AdminDateRangeFilter
          basePath="/admin/stats"
          from={rangeFrom}
          to={rangeTo}
          helperText="그래프는 선택한 날짜가 속한 달 기준으로 월별 표시됩니다."
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <AdminTrendChart title="누적 가입 공급사 수" points={subscriberPoints} color="#b91c1c" valueUnit="count" />
        <AdminTrendChart title="전체 공급사 구독료 합계" points={feePoints} color="#166534" valueUnit="won" />
      </div>
    </main>
  );
}
