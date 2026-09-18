import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { computeDueAt, isOverdue } from "@/lib/orders/receivables";
import { formatWon } from "@/lib/orders/status";
import { DEMO_ORDERS, DEMO_RETAILERS } from "@/lib/demo/supplier-samples";
import { getAlimtalkSettingsAction } from "@/app/actions/alimtalk-settings";
import { ReceivablesView } from "./receivables-view";
import type { ReceivableCustomerGroup, ReceivableOrderRow } from "./receivable-types";

export const metadata = {
  title: "미수금 정산 | 도매업체 통합관리시스템",
};

/** wholesaler_retailers 조회 응답 (거래처별 여신/연체 기준) */
interface RelationRow {
  retailer_id: string;
  credit_limit: number;
  outstanding_balance: number;
  settlement_due_days: number;
  retailers:
    | { restaurant_name: string }
    | Array<{ restaurant_name: string }>
    | null;
}

/** 미정산 외상 주문 조회 응답 */
interface CreditOrderRow {
  id: string;
  order_number: string;
  retailer_id: string;
  total_amount: number;
  ordered_at: string;
}

function buildGroups(
  relations: RelationRow[],
  creditOrders: CreditOrderRow[]
): ReceivableCustomerGroup[] {
  const ordersByRetailer = new Map<string, CreditOrderRow[]>();

  for (const order of creditOrders) {
    const list = ordersByRetailer.get(order.retailer_id) ?? [];
    list.push(order);
    ordersByRetailer.set(order.retailer_id, list);
  }

  const groups = relations.map((relation) => {
    const retailer = Array.isArray(relation.retailers) ? relation.retailers[0] : relation.retailers;
    const dueDays = relation.settlement_due_days;

    const orders: ReceivableOrderRow[] = (ordersByRetailer.get(relation.retailer_id) ?? [])
      .map((order) => {
        const dueAt = computeDueAt(order.ordered_at, dueDays);

        return {
          id: order.id,
          orderNumber: order.order_number,
          totalAmount: Number(order.total_amount),
          orderedAt: order.ordered_at,
          dueAt,
          isOverdue: isOverdue(dueAt),
        };
      })
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

    return {
      retailerId: relation.retailer_id,
      restaurantName: retailer?.restaurant_name ?? "이름 미등록 바이어",
      creditLimit: Number(relation.credit_limit ?? 0),
      outstandingBalance: Number(relation.outstanding_balance ?? 0),
      settlementDueDays: dueDays,
      orders,
    };
  });

  // 미정산 외상 주문이 있는 거래처만 남기고, 연체 있는 쪽 → 미수금 큰 쪽 순으로 보여준다.
  return groups
    .filter((group) => group.orders.length > 0)
    .sort((a, b) => {
      const aOverdue = a.orders.some((order) => order.isOverdue);
      const bOverdue = b.orders.some((order) => order.isOverdue);

      if (aOverdue !== bOverdue) {
        return aOverdue ? -1 : 1;
      }

      return b.outstandingBalance - a.outstandingBalance;
    });
}

function demoGroups(): ReceivableCustomerGroup[] {
  const relations: RelationRow[] = DEMO_RETAILERS.map((retailer) => ({
    retailer_id: retailer.id,
    credit_limit: retailer.credit_limit,
    outstanding_balance: retailer.outstanding_balance,
    settlement_due_days: retailer.settlement_due_days,
    retailers: { restaurant_name: retailer.restaurant_name },
  }));

  const creditOrders: CreditOrderRow[] = DEMO_ORDERS.filter(
    (order) => order.payment_method === "on_credit" && !order.settled_at && order.status !== "cancelled"
  ).map((order) => ({
    id: order.id,
    order_number: order.order_number,
    retailer_id: order.retailer_id,
    total_amount: order.total_amount,
    ordered_at: order.ordered_at,
  }));

  return buildGroups(relations, creditOrders);
}

export default async function DashboardReceivablesPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let groups: ReceivableCustomerGroup[] = [];
  let isDemoData = true;

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: relations }, { data: creditOrders }] = await Promise.all([
      supabase
        .from("wholesaler_retailers")
        .select(
          "retailer_id, credit_limit, outstanding_balance, settlement_due_days, retailers ( restaurant_name )"
        )
        .eq("wholesaler_id", scope.wholesalerId),
      supabase
        .from("orders")
        .select("id, order_number, retailer_id, total_amount, ordered_at")
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("payment_method", "on_credit")
        .is("settled_at", null)
        .neq("status", "cancelled"),
    ]);

    if (relations && relations.length > 0) {
      groups = buildGroups(relations as RelationRow[], (creditOrders ?? []) as CreditOrderRow[]);
      isDemoData = false;
    }
  }

  if (isDemoData) {
    groups = demoGroups();
  }

  // 리마인드 발송 버튼은 실제로 보낼 수 있는 상태(계정/비밀번호/발신정보/이 템플릿 코드까지
  // 전부 등록됨)일 때만 보여준다 — 절반만 설정된 상태에서 눌렀다가 실패하는 걸 막는다.
  const alimtalkSettingsResult = !isDemoData && scope?.wholesalerId ? await getAlimtalkSettingsAction() : null;
  const alimtalkSettings =
    alimtalkSettingsResult?.success && alimtalkSettingsResult.data ? alimtalkSettingsResult.data : null;
  const alimtalkReady = Boolean(
    alimtalkSettings?.configured &&
      alimtalkSettings.senderKey &&
      alimtalkSettings.senderPhone &&
      alimtalkSettings.templateCodes.receivablesReminder
  );

  const totalOutstanding = groups.reduce((sum, group) => sum + group.outstandingBalance, 0);
  const overdueCustomerCount = groups.filter((group) =>
    group.orders.some((order) => order.isOverdue)
  ).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>미수금 정산</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          외상(on_credit)으로 접수된 미정산 주문을 거래처별로 모아 보여줍니다. 정산 완료 처리하면
          해당 거래처의 미수금 잔액이 함께 줄어듭니다.
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
          ℹ️ 연결된 거래처가 없거나 미인증(데모) 상태여서 샘플 데이터를 표시하고 있습니다.
        </div>
      )}

      <section className="dash-cards">
        {[
          { label: "미수금 거래처", value: `${groups.length}곳`, accent: "#0f172a" },
          { label: "연체 거래처", value: `${overdueCustomerCount}곳`, accent: "#b91c1c" },
          { label: "총 미수금", value: formatWon(totalOutstanding), accent: "#b45309" },
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

      <ReceivablesView groups={groups} readOnly={isDemoData} alimtalkReady={alimtalkReady} />
    </div>
  );
}
