import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import {
  buildReceivableGroups,
  type ReceivableCreditOrderRow,
  type ReceivableCustomerGroup,
  type ReceivableRelationRow,
} from "@/lib/orders/receivables";
import { formatWon } from "@/lib/orders/status";
import { getAlimtalkSettingsAction } from "@/app/actions/alimtalk-settings";
import { ReceivablesView } from "./receivables-view";
import { CustomerTabs } from "../section-tabs";

export const metadata = {
  title: "미수금 정산 | 도매업체 통합관리시스템",
};

export default async function DashboardReceivablesPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let groups: ReceivableCustomerGroup[] = [];

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

    groups = buildReceivableGroups(
      (relations ?? []) as ReceivableRelationRow[],
      (creditOrders ?? []) as ReceivableCreditOrderRow[]
    );
  }

  // 리마인드 발송 버튼은 실제로 보낼 수 있는 상태(계정/비밀번호/발신정보/이 템플릿 코드까지
  // 전부 등록됨)일 때만 보여준다 — 절반만 설정된 상태에서 눌렀다가 실패하는 걸 막는다.
  const alimtalkSettingsResult = scope?.wholesalerId ? await getAlimtalkSettingsAction() : null;
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
      <CustomerTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>미수금 정산</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          외상(on_credit)으로 접수된 미정산 발주를 거래처별로 모아 보여줍니다. 정산 완료 처리하면
          해당 거래처의 미수금 잔액이 함께 줄어듭니다.
        </p>
      </header>

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

      <ReceivablesView groups={groups} alimtalkReady={alimtalkReady} />
    </div>
  );
}
