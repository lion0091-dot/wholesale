import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import {
  ORDER_STATUS_BADGES,
  formatOrderedAt,
  formatWon,
  resolveAlimtalkStatus,
} from "@/lib/orders/status";
import { isAlimtalkConfiguredForWholesaler } from "@/lib/notifications/alimtalk";
import { OrderStatusPanel } from "./order-status-panel";
import { TrackingPanel } from "./tracking-panel";
import { StatementPreviewButton } from "@/components/statement-preview-button";
import { TaxInvoiceDraftPanel } from "@/components/tax-invoice-draft-panel";
import { isSweetTrackerConfigured } from "@/lib/verification/sweettracker";
import { isPopbillConfigured } from "@/lib/popbill/client";
import { signExternalOpenToken } from "@/lib/pdf/external-open-token";
import type { OrderItem, OrderStatus } from "@/types/database";

export const metadata = {
  title: "발주 상세 | 도매업체 통합관리시스템",
};

interface PageProps {
  params: Promise<{ id: string }>;
}

interface RetailerInfo {
  restaurant_name: string;
  representative_name: string | null;
  business_number: string | null;
  delivery_address: string | null;
  delivery_address_detail: string | null;
}

interface OrderDetail {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  totalAmount: number;
  deliveryAddress: string;
  deliveryNotes: string | null;
  negotiationNote: string | null;
  orderedAt: string;
  updatedAt: string;
  items: OrderItem[];
  retailer: RetailerInfo;
  courierCode: string | null;
  trackingNumber: string | null;
}

/** 알림톡 발송 이력은 별도 적재 테이블이 없어 상태 진행 순서로 역산해 표시한다. */
const STAGE_ORDER: OrderStatus[] = [
  "pending",
  "awaiting_stock",
  "confirmed",
  "shipping",
  "delivered",
];

/** 정상 진행 단계에서 벗어난 취소 관련 상태 */
const CANCEL_FLOW_STATUSES: OrderStatus[] = ["cancel_requested", "cancel_rejected", "cancelled"];

function buildAlimtalkTimeline(status: OrderStatus): Array<{ status: OrderStatus; sent: boolean }> {
  // 취소 플로우(요청 -> 승인/반려)는 진행 단계와 별도 라인으로 표시한다.
  if (CANCEL_FLOW_STATUSES.includes(status)) {
    const timeline: Array<{ status: OrderStatus; sent: boolean }> = [
      { status: "pending", sent: true },
      { status: "cancel_requested", sent: true },
    ];

    if (status !== "cancel_requested") {
      timeline.push({ status, sent: true });
    }

    return timeline;
  }

  const currentIndex = STAGE_ORDER.indexOf(status);

  return STAGE_ORDER.map((stage, index) => ({ status: stage, sent: index <= currentIndex }));
}

function firstOrSelf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value;
}

async function loadOrder(
  orderId: string
): Promise<{ order: OrderDetail; wholesalerId: string } | null> {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    return null;
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("orders")
    .select(
      "*, order_items (*), retailers ( restaurant_name, representative_name, business_number, delivery_address, delivery_address_detail )"
    )
    .eq("id", orderId)
    .eq("wholesaler_id", scope.wholesalerId)
    .maybeSingle();

  if (!data) {
    return null;
  }

  const row = data as Record<string, unknown>;
  const retailer = firstOrSelf(row.retailers as RetailerInfo | RetailerInfo[] | null);

  return {
    wholesalerId: scope.wholesalerId,
    order: {
      id: row.id as string,
      orderNumber: row.order_number as string,
      status: row.status as OrderStatus,
      totalAmount: Number(row.total_amount),
      deliveryAddress: row.delivery_address as string,
      deliveryNotes: (row.delivery_notes as string | null) ?? null,
      negotiationNote: (row.negotiation_note as string | null) ?? null,
      orderedAt: row.ordered_at as string,
      updatedAt: row.updated_at as string,
      items: ((row.order_items as OrderItem[] | null) ?? []).slice().sort((a, b) =>
        a.created_at.localeCompare(b.created_at)
      ),
      retailer: {
        restaurant_name: retailer?.restaurant_name ?? "이름 미등록 고객(소매)",
        representative_name: retailer?.representative_name ?? null,
        business_number: retailer?.business_number ?? null,
        delivery_address: retailer?.delivery_address ?? null,
        delivery_address_detail: retailer?.delivery_address_detail ?? null,
      },
      courierCode: (row.courier_code as string | null) ?? null,
      trackingNumber: (row.tracking_number as string | null) ?? null,
    },
  };
}

const cardStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "16px",
} as const;

const cardTitleStyle = {
  fontSize: "13px",
  fontWeight: 700,
  color: "#0f172a",
  marginBottom: "10px",
} as const;

export default async function OrderDetailPage({ params }: PageProps) {
  const { id } = await params;
  const loaded = await loadOrder(id);

  if (!loaded) {
    notFound();
  }

  const { order, wholesalerId } = loaded;
  const badge = ORDER_STATUS_BADGES[order.status];
  const timeline = buildAlimtalkTimeline(order.status);
  const isLiveChannel = await isAlimtalkConfiguredForWholesaler(wholesalerId);

  // 카카오 인앱 브라우저 "외부에서 열기" 전용 — 세션 쿠키 없이도 인가되는 단발성 토큰.
  const statementExternalOpenHref = (() => {
    const token = signExternalOpenToken({
      kind: "supplier-statement",
      orderId: order.id,
      wholesalerId,
    });

    return token ? `/doc/${token}` : null;
  })();

  const taxInvoiceExternalOpenHref = (() => {
    const token = signExternalOpenToken({
      kind: "tax-invoice",
      orderId: order.id,
      wholesalerId,
    });

    return token ? `/doc/${token}` : null;
  })();

  const deliveryRequestExternalOpenHref = (() => {
    const token = signExternalOpenToken({
      kind: "delivery-request",
      orderId: order.id,
      wholesalerId,
    });

    return token ? `/doc/${token}` : null;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <Link href="/dashboard/orders" style={{ fontSize: "12px", color: "#64748b" }}>
          ← 발주 목록으로
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>
            {order.orderNumber}
          </h1>
          <span
            style={{
              fontSize: "12px",
              fontWeight: 700,
              backgroundColor: badge.bg,
              color: badge.color,
              borderRadius: "6px",
              padding: "4px 9px",
            }}
          >
            {badge.label}
          </span>
        </div>

        <p style={{ fontSize: "13px", color: "#64748b" }}>
          접수 {formatOrderedAt(order.orderedAt)} · 최근 변경 {formatOrderedAt(order.updatedAt)}
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
          <StatementPreviewButton
            href={`/dashboard/orders/${order.id}/statement`}
            label="거래명세서"
            externalOpenHref={statementExternalOpenHref}
          />
          <div>
            <StatementPreviewButton
              href={`/dashboard/orders/${order.id}/delivery-request`}
              label="배송의뢰서"
              externalOpenHref={deliveryRequestExternalOpenHref}
            />
            <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>
              ※ 지금은 참고용 문서만 만들어집니다. 택배사와 API 계약이 되면 자동 접수도 지원 예정입니다.
            </p>
          </div>
          <TaxInvoiceDraftPanel
            baseHref={`/dashboard/orders/${order.id}/tax-invoice`}
            orderId={order.id}
            defaultIssueDate={order.orderedAt.slice(0, 10)}
            externalOpenBaseHref={taxInvoiceExternalOpenHref}
            popbillConfigured={isPopbillConfigured()}
          />
        </div>
      </header>

      <OrderStatusPanel
        orderId={order.id}
        currentStatus={order.status}
      />

      {/* 주문 상품 목록 */}
      <section style={cardStyle}>
        <div style={cardTitleStyle}>발주 품목 ({order.items.length}개)</div>

        <div className="dash-table-wrap dash-desktop-only">
          <table className="dash-table">
            <thead>
              <tr>
                <th>상품명</th>
                <th>발주 단가</th>
                <th>수량</th>
                <th>금액</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 600 }}>
                    {item.category && (
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          color: "#475569",
                          backgroundColor: "#f1f5f9",
                          padding: "1px 5px",
                          borderRadius: "4px",
                          marginRight: "6px",
                        }}
                      >
                        {item.category}
                      </span>
                    )}
                    {item.product_name}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {formatWon(item.unit_price)}
                    {item.requested_unit_price != null &&
                      Number(item.requested_unit_price) !== Number(item.unit_price) && (
                        <div style={{ fontSize: "11px", color: "#b45309" }}>
                          고객 희망 {formatWon(item.requested_unit_price)}
                        </div>
                      )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{Number(item.quantity)}</td>
                  <td style={{ whiteSpace: "nowrap", fontWeight: 700 }}>
                    {formatWon(item.subtotal_amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="dash-mobile-only" style={{ flexDirection: "column", gap: "8px" }}>
          {order.items.map((item) => (
            <div
              key={item.id}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "12px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                {item.category && (
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      color: "#475569",
                      backgroundColor: "#f1f5f9",
                      padding: "1px 5px",
                      borderRadius: "4px",
                    }}
                  >
                    {item.category}
                  </span>
                )}
                <div style={{ fontWeight: 700, fontSize: "14px" }}>{item.product_name}</div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#64748b" }}>
                <span>{formatWon(item.unit_price)} × {Number(item.quantity)}</span>
                <span style={{ fontWeight: 700, color: "#0f172a" }}>{formatWon(item.subtotal_amount)}</span>
              </div>
              {item.requested_unit_price != null &&
                Number(item.requested_unit_price) !== Number(item.unit_price) && (
                  <div style={{ fontSize: "11px", color: "#b45309" }}>
                    고객 희망 {formatWon(item.requested_unit_price)}
                  </div>
                )}
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "baseline",
            gap: "8px",
            marginTop: "12px",
            paddingTop: "12px",
            borderTop: "1px solid #f1f5f9",
          }}
        >
          <span style={{ fontSize: "12px", color: "#64748b" }}>총 발주 금액</span>
          <span style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>
            {formatWon(order.totalAmount)}
          </span>
        </div>
      </section>

      <div className="dash-form-grid">
        {/* 배송지 정보 */}
        <section style={cardStyle}>
          <div style={cardTitleStyle}>배송지 정보</div>
          <dl style={{ display: "flex", flexDirection: "column", gap: "9px", fontSize: "13px" }}>
            {[
              { term: "발주처(소매)", value: order.retailer.restaurant_name },
              { term: "대표자", value: order.retailer.representative_name ?? "미등록" },
              { term: "사업자번호", value: order.retailer.business_number ?? "미등록" },
              { term: "배송 주소", value: order.deliveryAddress },
              {
                term: "등록 기본 배송지",
                value: order.retailer.delivery_address
                  ? `${order.retailer.delivery_address}${
                      order.retailer.delivery_address_detail
                        ? ` ${order.retailer.delivery_address_detail}`
                        : ""
                    }`
                  : "미등록",
              },
            ].map((row) => (
              <div key={row.term} style={{ display: "flex", gap: "10px" }}>
                <dt style={{ width: "104px", flexShrink: 0, color: "#64748b", fontWeight: 600 }}>
                  {row.term}
                </dt>
                <dd style={{ color: "#0f172a", wordBreak: "keep-all" }}>{row.value}</dd>
              </div>
            ))}
          </dl>

          {order.deliveryNotes && (
            <div
              style={{
                marginTop: "12px",
                backgroundColor: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: "8px",
                padding: "10px 12px",
                fontSize: "12px",
                color: "#92400e",
                lineHeight: 1.6,
              }}
            >
              <strong>배송 요청사항</strong>
              <div style={{ marginTop: "3px" }}>{order.deliveryNotes}</div>
            </div>
          )}

          {order.negotiationNote && (
            <div
              style={{
                marginTop: "12px",
                backgroundColor: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "8px",
                padding: "10px 12px",
                fontSize: "12px",
                color: "#991b1b",
                lineHeight: 1.6,
              }}
            >
              <strong>가격 관련 요청 (고객)</strong>
              <div style={{ marginTop: "3px" }}>{order.negotiationNote}</div>
            </div>
          )}
        </section>

        <TrackingPanel
          orderId={order.id}
          courierCode={order.courierCode}
          trackingNumber={order.trackingNumber}
          sweetTrackerConfigured={isSweetTrackerConfigured()}
        />

        {/* 알림톡 발송 상태 */}
        <section style={cardStyle}>
          <div style={cardTitleStyle}>
            알림톡 발송 상태 {isLiveChannel ? "(실발송)" : "(미발송·연동 필요)"}
          </div>

          <ol style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "12px" }}>
            {timeline.map((stage) => {
              const alimtalk = resolveAlimtalkStatus(stage.status);

              return (
                <li
                  key={stage.status}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    opacity: stage.sent ? 1 : 0.45,
                  }}
                >
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      backgroundColor: stage.sent ? alimtalk.bg : "#f1f5f9",
                      color: stage.sent ? alimtalk.color : "#94a3b8",
                      borderRadius: "4px",
                      padding: "4px 8px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {stage.sent ? "발송 완료" : "발송 대기"}
                  </span>
                  <span style={{ color: "#0f172a", fontWeight: 600 }}>{alimtalk.label}</span>
                  <span style={{ color: "#94a3b8" }}>→ {alimtalk.target}</span>
                </li>
              );
            })}
          </ol>

          {!isLiveChannel && (
            <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "12px", lineHeight: 1.6 }}>
              이 공급사가 아직 비즈뿌리오 연동을 등록하지 않아 알림톡이 서버 로그로만 기록됩니다.
              /dashboard/invites에서 비즈뿌리오 계정을 등록하면 실발송으로 전환됩니다.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
