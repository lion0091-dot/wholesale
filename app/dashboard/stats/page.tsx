import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { DEMO_ORDERS } from "@/lib/demo/supplier-samples";
import { formatWon } from "@/lib/orders/status";
import type { OrderItem, OrderStatus } from "@/types/database";

export const metadata = {
  title: "판매 통계 | 도매업체 통합관리시스템",
};

type RangeKey = "7d" | "30d" | "month" | "all";

const RANGE_LABELS: Record<RangeKey, string> = {
  "7d": "최근 7일",
  "30d": "최근 30일",
  month: "이번 달",
  all: "전체 기간",
};

function rangeStart(range: RangeKey): string | null {
  const now = new Date();

  if (range === "7d") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (range === "30d") {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (range === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }

  return null;
}

type StatItem = Pick<OrderItem, "category" | "subcategory" | "quantity" | "subtotal_amount">;

interface SubcategoryStat {
  label: string;
  quantity: number;
  amount: number;
}

interface CategoryStat {
  label: string;
  quantity: number;
  amount: number;
  subcategories: SubcategoryStat[];
}

const UNCATEGORIZED = "미분류";

function aggregateByCategory(items: StatItem[]): CategoryStat[] {
  const categories = new Map<string, { quantity: number; amount: number; subs: Map<string, SubcategoryStat> }>();

  for (const item of items) {
    const categoryLabel = item.category ?? UNCATEGORIZED;
    const subLabel = item.subcategory ?? "부위 미지정";
    const quantity = Number(item.quantity);
    const amount = Number(item.subtotal_amount);

    if (!categories.has(categoryLabel)) {
      categories.set(categoryLabel, { quantity: 0, amount: 0, subs: new Map() });
    }

    const bucket = categories.get(categoryLabel)!;
    bucket.quantity += quantity;
    bucket.amount += amount;

    const sub = bucket.subs.get(subLabel) ?? { label: subLabel, quantity: 0, amount: 0 };
    sub.quantity += quantity;
    sub.amount += amount;
    bucket.subs.set(subLabel, sub);
  }

  return Array.from(categories.entries())
    .map(([label, bucket]) => ({
      label,
      quantity: bucket.quantity,
      amount: bucket.amount,
      subcategories: Array.from(bucket.subs.values()).sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => b.amount - a.amount);
}

interface OrderJoinRow {
  status: OrderStatus;
  ordered_at: string;
  order_items: StatItem[] | null;
}

export default async function DashboardStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const { range: rawRange } = await searchParams;
  const range: RangeKey =
    rawRange === "7d" || rawRange === "30d" || rawRange === "all" ? rawRange : "month";
  const start = rangeStart(range);

  let items: StatItem[] = [];
  let isDemoData = true;

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    let query = supabase
      .from("orders")
      .select("status, ordered_at, order_items ( category, subcategory, quantity, subtotal_amount )")
      .eq("wholesaler_id", scope.wholesalerId)
      .neq("status", "cancelled");

    if (start) {
      query = query.gte("ordered_at", start);
    }

    const { data } = await query;

    if (data && data.length > 0) {
      items = (data as OrderJoinRow[]).flatMap((order) => order.order_items ?? []);
      isDemoData = false;
    }
  }

  if (isDemoData) {
    const startDate = start ? new Date(start) : null;

    items = DEMO_ORDERS.filter(
      (order) =>
        order.status !== "cancelled" && (!startDate || new Date(order.ordered_at) >= startDate)
    ).flatMap((order) => order.items);
  }

  const categories = aggregateByCategory(items);
  const totalAmount = categories.reduce((sum, c) => sum + c.amount, 0);
  const totalQuantity = categories.reduce((sum, c) => sum + c.quantity, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>판매 통계</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          축종 → 부위 기준으로 판매량/매출을 집계합니다. 취소된 주문은 제외됩니다.
        </p>
      </header>

      {isDemoData && (
        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
          }}
        >
          ℹ️ 접수된 주문이 없거나 미인증(데모) 상태여서 샘플 데이터를 표시하고 있습니다.
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {(Object.keys(RANGE_LABELS) as RangeKey[]).map((key) => (
          <Link
            key={key}
            href={`/dashboard/stats?range=${key}`}
            style={{
              fontSize: "13px",
              fontWeight: 700,
              padding: "6px 12px",
              borderRadius: "999px",
              border: "1px solid " + (range === key ? "#0f172a" : "#e2e8f0"),
              backgroundColor: range === key ? "#0f172a" : "#ffffff",
              color: range === key ? "#ffffff" : "#475569",
              textDecoration: "none",
            }}
          >
            {RANGE_LABELS[key]}
          </Link>
        ))}
      </div>

      <section className="dash-cards">
        <div
          style={{
            backgroundColor: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "12px",
            padding: "14px 16px",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>
            누적 판매 금액 ({RANGE_LABELS[range]})
          </div>
          <div style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px" }}>
            {formatWon(totalAmount)}
          </div>
        </div>
        <div
          style={{
            backgroundColor: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "12px",
            padding: "14px 16px",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>누적 판매 수량</div>
          <div style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px" }}>
            {totalQuantity.toLocaleString("ko-KR")}
          </div>
        </div>
      </section>

      {categories.length === 0 ? (
        <p style={{ padding: "32px 16px", textAlign: "center", fontSize: "13px", color: "#94a3b8" }}>
          해당 기간에 판매된 품목이 없습니다.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {categories.map((category) => (
            <section
              key={category.label}
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "12px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 16px",
                  backgroundColor: "#f8fafc",
                  borderBottom: "1px solid #e2e8f0",
                }}
              >
                <span style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>
                  {category.label}
                </span>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#334155" }}>
                  {formatWon(category.amount)}
                  <span style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 400 }}>
                    {" "}
                    · {category.quantity.toLocaleString("ko-KR")}
                  </span>
                </span>
              </div>

              <div className="dash-table-wrap dash-desktop-only">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>부위</th>
                      <th>수량</th>
                      <th>매출</th>
                    </tr>
                  </thead>
                  <tbody>
                    {category.subcategories.map((sub) => (
                      <tr key={sub.label}>
                        <td>{sub.label}</td>
                        <td>{sub.quantity.toLocaleString("ko-KR")}</td>
                        <td>{formatWon(sub.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="dash-mobile-only" style={{ flexDirection: "column", gap: "6px", padding: "10px 12px" }}>
                {category.subcategories.map((sub) => (
                  <div
                    key={sub.label}
                    style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "4px 0" }}
                  >
                    <span style={{ color: "#334155" }}>{sub.label}</span>
                    <span style={{ color: "#64748b" }}>{sub.quantity.toLocaleString("ko-KR")}개</span>
                    <span style={{ fontWeight: 700 }}>{formatWon(sub.amount)}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
