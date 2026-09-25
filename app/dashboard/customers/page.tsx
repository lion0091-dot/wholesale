import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { isRetailerNamePlaceholder } from "@/lib/shop/retailer-placeholder";
import {
  describeInviteRestriction,
  getSupplierAccount,
} from "@/lib/supplier/verification";
import { PendingApprovalBanner } from "@/components/pending-approval-banner";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { formatWon } from "@/lib/orders/status";
import { INVITE_RESEND_COOLDOWN_DAYS, type OutboundSmsQueueRow } from "@/lib/notifications/sms-queue";
import { CustomerTable } from "./customer-table";
import { InviteSmsQueuePanel } from "./invite-sms-queue-panel";
import type { CustomerRow } from "./customer-types";
import type { OrderStatus, RelationshipStatus } from "@/types/database";
import { CustomerTabs } from "../section-tabs";

export const metadata = {
  title: "고객 관리 | 도매업체 통합관리시스템",
};

/** wholesaler_retailers + retailers 조인 응답 형태 */
interface RelationJoinRow {
  retailer_id: string;
  status: RelationshipStatus;
  status_changed_at: string;
  block_reason: string | null;
  memo: string | null;
  created_at: string;
  credit_limit: number;
  outstanding_balance: number;
  settlement_due_days: number;
  allowed_payment_methods: string[] | null;
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

/**
 * 카카오 로그인만 하고 첫 발주서를 아직 안 써본 거래처는 상호/배송지가
 * claim_shop_access() RPC가 채워둔 자리표시자("카카오 회원", 빈 배송지)로 남아있다.
 * 담당자 정보도 같은 카카오 계정 하나로 결정되므로 이 두 필드만 보면 충분하다.
 */
function hasIncompleteProfile(
  restaurantName: string | null | undefined,
  deliveryAddress: string | null | undefined
): boolean {
  return isRetailerNamePlaceholder(restaurantName) || !deliveryAddress;
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

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  // 초대장 발부는 행정 승인(is_verified) 후에만 열린다.
  const account = await getSupplierAccount();
  const canIssueInvite = account?.canIssueInvite ?? false;
  const inviteRestriction = account
    ? describeInviteRestriction(account)
    : "로그인 후 승인된 공급사 계정에서만 초대장을 발부할 수 있습니다.";

  let customers: CustomerRow[] = [];
  let shopToken: string | null = null;
  let pgConfigured = false;
  let inviteSmsQueue: OutboundSmsQueueRow[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [
      { data: relations },
      { data: customPriceRows },
      { data: orderRows },
      { data: wholesalerRow },
      { data: phoneRows },
      { data: queueRows },
    ] = await Promise.all([
      supabase
        .from("wholesaler_retailers")
        .select(
          "retailer_id, status, status_changed_at, block_reason, memo, created_at, credit_limit, outstanding_balance, settlement_due_days, allowed_payment_methods, retailers ( restaurant_name, business_number, representative_name, delivery_address, delivery_address_detail )"
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
      supabase
        .from("wholesalers")
        .select("pg_client_key")
        .eq("id", scope.wholesalerId)
        .maybeSingle(),
      supabase.rpc("list_linked_retailer_phones", { p_wholesaler_id: scope.wholesalerId }),
      supabase
        .from("outbound_sms_queue")
        .select("id, retailer_id, recipient_name, recipient_phone, message_body, status, created_at")
        .eq("message_type", "retailer_invite")
        .eq("wholesaler_id", scope.wholesalerId)
        // 화면에는 거래처별 최신 행 하나만 필요하다. 그 행이 쿨다운 기간보다 오래된
        // "발송완료" 행이면 재발송 가능 상태와 다를 게 없으므로, pending이거나 최근
        // 쿨다운 기간 이내인 행만 가져와 쌓여가는 전체 발송 이력을 매번 다 읽지 않는다
        // (app/dashboard/customers/actions.ts의 generateInviteSmsQueueAction과 동일한 경계).
        // 기준은 sent_at(실제 발송 시각)이어야 한다 — created_at(큐 등록 시각)로 거르면
        // 오래전에 큐에 들어갔다가 최근에야 수동 발송된 행이 목록에서 빠져버린다.
        .or(`status.eq.pending,sent_at.gte.${new Date(Date.now() - INVITE_RESEND_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()}`)
        .order("created_at", { ascending: false }),
    ]);

    pgConfigured = Boolean(wholesalerRow?.pg_client_key);

    // 재발송(30일 쿨다운) 도입 후 같은 거래처가 여러 행(과거 발송 이력 + 최신 대기)으로
    // 쌓일 수 있다 — 화면에는 거래처당 가장 최근 행 하나만 보여준다(created_at 내림차순
    // 정렬을 그대로 활용).
    const latestQueueRowByRetailer = new Map<
      string,
      { id: string; recipient_name: string; recipient_phone: string; message_body: string; status: "pending" | "sent"; created_at: string }
    >();

    for (const row of (queueRows ?? []) as Array<{
      id: string;
      retailer_id: string;
      recipient_name: string;
      recipient_phone: string;
      message_body: string;
      status: "pending" | "sent";
      created_at: string;
    }>) {
      if (!latestQueueRowByRetailer.has(row.retailer_id)) {
        latestQueueRowByRetailer.set(row.retailer_id, row);
      }
    }

    inviteSmsQueue = Array.from(latestQueueRowByRetailer.values()).map((row) => ({
      id: row.id,
      recipientName: row.recipient_name,
      recipientPhone: row.recipient_phone,
      messageBody: row.message_body,
      status: row.status,
      createdAt: row.created_at,
    }));

    const customPriceCounts = countByRetailer((customPriceRows ?? []) as Array<{ retailer_id: string }>);
    const orderStats = aggregateOrderStats((orderRows ?? []) as OrderStatRow[]);
    const phoneByRetailer = new Map(
      ((phoneRows ?? []) as Array<{ retailer_id: string; phone: string | null }>).map((row) => [
        row.retailer_id,
        row.phone,
      ])
    );

    customers = ((relations ?? []) as RelationJoinRow[]).map((row) => {
      const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;
      const stat = orderStats.get(row.retailer_id);

      return {
        id: row.retailer_id,
        restaurantName: retailer?.restaurant_name ?? "이름 미등록 고객(소매)",
        representativeName: retailer?.representative_name ?? "미등록",
        businessNumber: retailer?.business_number ?? null,
        deliveryAddress: fullAddress(
          retailer?.delivery_address,
          retailer?.delivery_address_detail
        ),
        relationStatus: row.status,
        statusChangedAt: row.status_changed_at,
        blockReason: row.block_reason,
        memo: row.memo,
        joinedAt: row.created_at,
        customPriceCount: customPriceCounts.get(row.retailer_id) ?? 0,
        orderCount: stat?.orderCount ?? 0,
        lastOrderedAt: stat?.lastOrderedAt ?? null,
        totalOrderAmount: stat?.totalOrderAmount ?? 0,
        creditLimit: Number(row.credit_limit ?? 0),
        outstandingBalance: Number(row.outstanding_balance ?? 0),
        settlementDueDays: Number(row.settlement_due_days ?? 30),
        allowedPaymentMethods: row.allowed_payment_methods ?? ["prepaid"],
        contactPhone: phoneByRetailer.get(row.retailer_id) ?? null,
        hasIncompleteProfile: hasIncompleteProfile(
          retailer?.restaurant_name,
          retailer?.delivery_address
        ),
      };
    });

    shopToken = scope.shopToken ?? null;
  }

  const activeCount = customers.filter((customer) => customer.relationStatus === "active").length;
  const customPricedCount = customers.filter((customer) => customer.customPriceCount > 0).length;
  const totalAmount = customers.reduce((sum, customer) => sum + customer.totalOrderAmount, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <CustomerTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>고객 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          단골 고객(소매)의 사업자 정보와 발주 실적을 확인하고, 미니샵 전용 초대 링크를
          발송합니다.
        </p>
      </header>

      {account && !canIssueInvite && inviteRestriction && (
        <PendingApprovalBanner message={inviteRestriction} showInviteLink />
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

      {canIssueInvite && <InviteSmsQueuePanel initialQueue={inviteSmsQueue} />}

      <CustomerTable
        customers={customers}
        shopToken={canIssueInvite ? shopToken : null}
        canIssueInvite={canIssueInvite}
        inviteRestriction={inviteRestriction}
        pgConfigured={pgConfigured}
      />
    </div>
  );
}
