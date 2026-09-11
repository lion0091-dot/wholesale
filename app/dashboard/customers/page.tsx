import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import {
  DEMO_CUSTOM_PRICES,
  DEMO_ORDERS,
  DEMO_RETAILERS,
} from "@/lib/demo/supplier-samples";
import { formatWon } from "@/lib/orders/status";
import { CustomerTable, type CustomerRow } from "./customer-table";
import type { OrderStatus, RelationshipStatus } from "@/types/database";

export const metadata = {
  title: "고객 관리 | 공급사 백오피스",
};

const DEMO_SHOP_TOKEN = "demo-token-12345";

/** wholesaler_retailers + retailers 조인 응답 형태 */
interface RelationJoinRow {
  retailer_id: string;
  status: RelationshipStatus;
  memo: string | null;
  created_at: string;
  retailers:
    | {
        restaurant_name: string;
        business_number: string | null;
        representative_name: string;
        delivery_address: string;
        delivery_address_detail: string | null;
      }
    | Array<{
        restaurant_name: string;
        business_number: string | null;
        representative_name: string;
        delivery_address: string;
        delivery_address_detail: string | null;
      }>
    | null;
}

interface OrderStatRow {
  retailer_id: string;
  total_amount: number;
  status: OrderStatus;
  ordered_at: string;
}

interface OrderStat {
  orderCount: number;
  totalOrderAmount: number;
  lastOrderedAt: string | null;
}

function fullAddress(
  address: string | null | undefined,
  detail: string | null | undefined
): string {
  if (!address) {
    return "배송지 미등록";
  }

  return detail ? `${address} ${detail}` : address;
}

/** 취소 건은 실적 금액에서 제외하고, 최근 발주 일시는 전체 기준으로 집계한다. */
function aggregateOrderStats(rows: OrderStatRow[]): Map<string, OrderStat> {
  const stats = new Map<string, OrderStat>();

  for (const row of rows) {
    const current =
      stats.get(row.retailer_id) ?? { orderCount: 0, totalOrderAmount: 0, lastOrderedAt: null };

    current.orderCount += 1;

    if (row.status !== "cancelled") {
      current.totalOrderAmount += Number(row.total_amount);
    }

    if (!current.lastOrderedAt || row.ordered_at > current.lastOrderedAt) {
      current.lastOrderedAt = row.ordered_at;
    }

    stats.set(row.retailer_id, current);
  }

  return stats;
}

function countByRetailer(rows: Array<{ retailer_id: string }>): Map<string, number> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    counts.set(row.retailer_id, (counts.get(row.retailer_id) ?? 0) + 1);
  }

  return counts;
}

export default async function DashboardCustomersPage() {
  const scope = await getSupplierScope();

  let customers: CustomerRow[] = [];
  let shopToken = DEMO_SHOP_TOKEN;
  let wholesalerName = "마장동 태양축산 (테스트 도매)";
  let isDemoData = true;

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: relations }, { data: customPriceRows }, { data: orderRows }] = await Promise.all([
      supabase
        .from("wholesaler_retailers")
        .select(
          "retailer_id, status, memo, created_at, retailers ( restaurant_name, business_number, representative_name, delivery_address, delivery_address_detail )"
        )
        .eq("wholesaler_id", scope.wholesalerId)
        .order("created_at", { ascending: false }),
      supabase
        .from("custom_prices")
        .select("retailer_id")
        .eq("wholesaler_id", scope.wholesalerId),
      supabase
        .from("orders")
        .select("retailer_id, total_amount, status, ordered_at")
        .eq("wholesaler_id", scope.wholesalerId),
    ]);

    if (relations && relations.length > 0) {
      const customPriceCounts = countByRetailer((customPriceRows ?? []) as Array<{ retailer_id: string }>);
      const orderStats = aggregateOrderStats((orderRows ?? []) as OrderStatRow[]);

      customers = (relations as RelationJoinRow[]).map((row) => {
        const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;
        const stat = orderStats.get(row.retailer_id);

        return {
          id: row.retailer_id,
          restaurantName: retailer?.restaurant_name ?? "이름 미등록 바이어",
          representativeName: retailer?.representative_name ?? "미등록",
          businessNumber: retailer?.business_number ?? null,
          deliveryAddress: fullAddress(
            retailer?.delivery_address,
            retailer?.delivery_address_detail
          ),
          relationStatus: row.status,
          memo: row.memo,
          joinedAt: row.created_at,
          customPriceCount: customPriceCounts.get(row.retailer_id) ?? 0,
          orderCount: stat?.orderCount ?? 0,
          lastOrderedAt: stat?.lastOrderedAt ?? null,
          totalOrderAmount: stat?.totalOrderAmount ?? 0,
        };
      });

      shopToken = scope.shopToken ?? DEMO_SHOP_TOKEN;
      wholesalerName = scope.businessName;
      isDemoData = false;
    }
  }

  if (isDemoData) {
    const customPriceCounts = countByRetailer(DEMO_CUSTOM_PRICES);
    const orderStats = aggregateOrderStats(
      DEMO_ORDERS.map((order) => ({
        retailer_id: order.retailer_id,
        total_amount: order.total_amount,
        status: order.status,
        ordered_at: order.ordered_at,
      }))
    );

    customers = DEMO_RETAILERS.map((retailer) => {
      const stat = orderStats.get(retailer.id);

      return {
        id: retailer.id,
        restaurantName: retailer.restaurant_name,
        representativeName: retailer.representative_name,
        businessNumber: retailer.business_number,
        deliveryAddress: fullAddress(
          retailer.delivery_address,
          retailer.delivery_address_detail
        ),
        relationStatus: retailer.status,
        memo: retailer.memo,
        joinedAt: retailer.created_at,
        customPriceCount: customPriceCounts.get(retailer.id) ?? 0,
        orderCount: stat?.orderCount ?? 0,
        lastOrderedAt: stat?.lastOrderedAt ?? null,
        totalOrderAmount: stat?.totalOrderAmount ?? 0,
      };
    });
  }

  const activeCount = customers.filter((customer) => customer.relationStatus === "active").length;
  const customPricedCount = customers.filter((customer) => customer.customPriceCount > 0).length;
  const totalAmount = customers.reduce((sum, customer) => sum + customer.totalOrderAmount, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>고객 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          단골 바이어(구매 회원)의 사업자 정보와 발주 실적을 확인하고, 미니샵 전용 초대 링크를
          발송합니다.
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
          ℹ️ 연결된 거래처가 없거나 미인증(데모) 상태여서 샘플 고객 데이터를 표시하고 있습니다.
        </div>
      )}

      <section className="dash-cards">
        {[
          { label: "거래중 고객", value: `${activeCount}곳`, accent: "#0f172a" },
          { label: "맞춤 단가 적용", value: `${customPricedCount}곳`, accent: "#5b21b6" },
          { label: "누적 발주 금액", value: formatWon(totalAmount), accent: "#b91c1c" },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "12px",
              padding: "14px 16px",
            }}
          >
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>{card.label}</div>
            <div style={{ fontSize: "22px", fontWeight: 800, color: card.accent, marginTop: "4px" }}>
              {card.value}
            </div>
          </div>
        ))}
      </section>

      <CustomerTable
        customers={customers}
        shopToken={shopToken}
        wholesalerName={wholesalerName}
        readOnly={isDemoData}
      />
    </div>
  );
}
