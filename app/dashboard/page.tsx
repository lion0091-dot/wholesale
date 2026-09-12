import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getOrgStaffContext } from "@/lib/auth/rbac";
import { CopyInviteButton } from "@/components/copy-invite-button";
import type { OrderStatus } from "@/types/database";

interface DashboardOrder {
  id: string;
  order_number: string;
  total_amount: number;
  status: OrderStatus;
  ordered_at: string;
}

const STATUS_LABELS: Record<OrderStatus, { label: string; bg: string; color: string }> = {
  pending: { label: "신규 접수", bg: "#fef3c7", color: "#92400e" },
  confirmed: { label: "접수 확인", bg: "#dbeafe", color: "#1e40af" },
  shipping: { label: "배송 중", bg: "#e0e7ff", color: "#3730a3" },
  delivered: { label: "배송 완료", bg: "#dcfce7", color: "#166534" },
  cancel_requested: { label: "취소 요청", bg: "#ffedd5", color: "#9a3412" },
  cancel_rejected: { label: "취소 반려", bg: "#f1f5f9", color: "#475569" },
  cancelled: { label: "주문 취소", bg: "#fee2e2", color: "#991b1b" },
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 집계 기준일은 한국 시간(KST) 자정으로 고정한다. */
function kstBoundaries() {
  const kstNow = new Date(Date.now() + KST_OFFSET_MS);
  const todayStart = new Date(
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - KST_OFFSET_MS
  );
  const monthStart = new Date(
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), 1) - KST_OFFSET_MS
  );

  return { todayStart, monthStart };
}

function formatWon(amount: number) {
  return `${Math.round(amount).toLocaleString("ko-KR")}원`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "16px 18px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

function SummaryCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent: string;
}) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>{label}</div>
      <div style={{ fontSize: "26px", fontWeight: 800, color: accent, margin: "6px 0 4px" }}>
        {value}
      </div>
      <div style={{ fontSize: "12px", color: "#94a3b8" }}>{hint}</div>
    </div>
  );
}

export default async function DashboardPage() {
  const context = await getOrgStaffContext();
  const { todayStart, monthStart } = kstBoundaries();

  let businessName = "마장동 태양축산 (테스트 도매)";
  let shopToken = "demo-token-12345";
  let activeCustomerCount = 0;
  let activeProductCount = 0;
  let orders: DashboardOrder[] = [];
  let isDemoData = true;

  if (context) {
    const supabase = await createClient();

    // 조직에 연결된 wholesalers 레코드를 찾는다 (조직 생성 전이면 profile로 직접 조회).
    let wholesalerId: string | null = null;

    if (context.organizationId) {
      const { data: organization } = await supabase
        .from("organizations")
        .select("wholesaler_id")
        .eq("id", context.organizationId)
        .maybeSingle();

      wholesalerId = (organization?.wholesaler_id as string | null) ?? null;
    }

    const { data: wholesaler } = wholesalerId
      ? await supabase
          .from("wholesalers")
          .select("id, business_name, shop_token")
          .eq("id", wholesalerId)
          .maybeSingle()
      : await supabase
          .from("wholesalers")
          .select("id, business_name, shop_token")
          .eq("profile_id", context.userId)
          .maybeSingle();

    if (wholesaler) {
      wholesalerId = wholesaler.id as string;
      businessName = (wholesaler.business_name as string) ?? businessName;
      shopToken = (wholesaler.shop_token as string) ?? shopToken;

      const [{ data: monthOrders }, { count: customerCount }, { count: productCount }] =
        await Promise.all([
          supabase
            .from("orders")
            .select("id, order_number, total_amount, status, ordered_at")
            .eq("wholesaler_id", wholesalerId)
            .gte("ordered_at", monthStart.toISOString())
            .order("ordered_at", { ascending: false }),
          supabase
            .from("wholesaler_retailers")
            .select("id", { count: "exact", head: true })
            .eq("wholesaler_id", wholesalerId)
            .eq("status", "active"),
          supabase
            .from("products")
            .select("id", { count: "exact", head: true })
            .eq("wholesaler_id", wholesalerId)
            .eq("is_active", true),
        ]);

      activeCustomerCount = customerCount ?? 0;
      activeProductCount = productCount ?? 0;

      if (monthOrders) {
        orders = monthOrders as DashboardOrder[];
        isDemoData = false;
      }
    }
  }

  // 미인증(데모) 또는 이번 달 데이터가 아직 없을 때 보여줄 샘플 요약
  if (isDemoData) {
    const minutesAgo = (minutes: number) =>
      new Date(Date.now() - minutes * 60 * 1000).toISOString();

    orders = [
      {
        id: "demo-order-1",
        order_number: "ORD-20260911-A79B2C",
        total_amount: 255000,
        status: "pending",
        ordered_at: minutesAgo(30),
      },
      {
        id: "demo-order-2",
        order_number: "ORD-20260911-E54D1F",
        total_amount: 185000,
        status: "confirmed",
        ordered_at: minutesAgo(180),
      },
      {
        id: "demo-order-3",
        order_number: "ORD-20260910-C21A88",
        total_amount: 412000,
        status: "delivered",
        ordered_at: minutesAgo(60 * 30),
      },
    ];
    activeCustomerCount = 8;
    activeProductCount = 12;
  }

  const todayOrders = orders.filter((order) => new Date(order.ordered_at) >= todayStart);
  const todaySales = todayOrders
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + Number(order.total_amount), 0);
  const monthSales = orders
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + Number(order.total_amount), 0);
  const pendingCount = orders.filter((order) => order.status === "pending").length;
  const recentOrders = orders.slice(0, 5);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>
          {businessName} 대시보드
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          오늘의 발주 현황과 매출 요약을 확인하고, 바이어(구매 회원) 전용 미니샵 초대 링크를
          전달하세요.
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
          ℹ️ 실제 발주 데이터가 없어 샘플 요약을 표시하고 있습니다. (데모/개발 모드)
        </div>
      )}

      <section className="dash-cards">
        <SummaryCard
          label="오늘의 주문 건수"
          value={`${todayOrders.length}건`}
          hint={`처리 대기(신규 접수) ${pendingCount}건`}
          accent="#dc2626"
        />
        <SummaryCard
          label="오늘 매출"
          value={formatWon(todaySales)}
          hint="취소 주문 제외 · KST 기준"
          accent="#0f172a"
        />
        <SummaryCard
          label="이번 달 매출"
          value={formatWon(monthSales)}
          hint={`누적 주문 ${orders.length}건`}
          accent="#2563eb"
        />
      </section>

      <section style={cardStyle}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>
          미니샵 초대 링크
        </div>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6, marginBottom: "12px" }}>
          카카오톡으로 전달할 초대 문구와 전용 발주 링크를 한 번에 복사합니다. 링크를 받은
          바이어만 내 미니샵과 단가를 볼 수 있습니다.
        </p>
        <CopyInviteButton shopToken={shopToken} wholesalerName={businessName} />
      </section>

      <section className="dash-cards">
        <SummaryCard
          label="거래 중인 바이어"
          value={`${activeCustomerCount}곳`}
          hint="초대 수락 후 거래 활성 상태"
          accent="#0f172a"
        />
        <SummaryCard
          label="판매 중인 상품"
          value={`${activeProductCount}개`}
          hint="미니샵에 노출되는 활성 상품"
          accent="#0f172a"
        />
        <div style={cardStyle}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b", marginBottom: "10px" }}>
            바로가기
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Link
              href="/dashboard/products"
              style={{ fontSize: "13px", fontWeight: 600, color: "#2563eb" }}
            >
              상품 등록 / 단가 수정 →
            </Link>
            <Link
              href="/dashboard/custom-prices"
              style={{ fontSize: "13px", fontWeight: 600, color: "#2563eb" }}
            >
              바이어별 맞춤 단가 설정 →
            </Link>
            <Link
              href="/dashboard/orders"
              style={{ fontSize: "13px", fontWeight: 600, color: "#2563eb" }}
            >
              발주 접수 처리 →
            </Link>
          </div>
        </div>
      </section>

      <section style={cardStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "12px",
          }}
        >
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>최근 발주</div>
          <Link href="/dashboard/orders" style={{ fontSize: "12px", color: "#2563eb" }}>
            전체 보기 →
          </Link>
        </div>

        {recentOrders.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8" }}>이번 달 접수된 발주서가 없습니다.</p>
        ) : (
          <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" }}>
            {recentOrders.map((order) => {
              const status = STATUS_LABELS[order.status] ?? STATUS_LABELS.pending;

              return (
                <li
                  key={order.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "10px 12px",
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      backgroundColor: status.bg,
                      color: status.color,
                      borderRadius: "4px",
                      padding: "3px 7px",
                    }}
                  >
                    {status.label}
                  </span>
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a" }}>
                    {order.order_number}
                  </span>
                  <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                    {formatTime(order.ordered_at)}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "#0f172a",
                    }}
                  >
                    {formatWon(Number(order.total_amount))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
