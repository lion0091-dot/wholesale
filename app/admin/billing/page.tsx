import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import type { OutboundSmsQueueRow } from "@/lib/notifications/sms-queue";
import { AdminNav } from "@/components/admin-nav";
import { BillingInvoiceList, type InvoiceRow } from "./billing-invoice-list";
import { InvoiceSmsQueuePanel } from "./invoice-sms-queue-panel";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function todayDateStringKst(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDateString(dateStr: string, monthsDelta: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);

  return new Date(Date.UTC(year, month - 1 + monthsDelta, day)).toISOString().slice(0, 10);
}

const DEMO_INVOICES: InvoiceRow[] = [
  {
    id: "demo-invoice-1",
    wholesalerId: "demo-wholesaler-1",
    businessName: "마장동 태양축산 (테스트 공급사)",
    businessNumber: "123-45-67890",
    billingMonth: `${todayDateStringKst().slice(0, 7)}-01`,
    billedRetailerCount: 12,
    fullMonthFee: 60000,
    amount: 60000,
    status: "unpaid",
    paidAt: null,
    collectedByName: null,
    memo: null,
  },
];

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function AdminBillingPage({ searchParams }: PageProps) {
  const isConfigured = isSupabaseConfigured();

  if (isConfigured && !(await isSuperAdminSession())) {
    redirect("/login?next=/admin/billing");
  }

  const params = await searchParams;
  const today = todayDateStringKst();
  const defaultFrom = shiftDateString(today, -3);

  const from = params.from && DATE_PATTERN.test(params.from) ? params.from : defaultFrom;
  const to = params.to && DATE_PATTERN.test(params.to) ? params.to : today;
  const [rangeFrom, rangeTo] = from <= to ? [from, to] : [to, from];
  const rangeFromMonth = `${rangeFrom.slice(0, 7)}-01`;
  const rangeToMonth = `${rangeTo.slice(0, 7)}-01`;

  let invoices: InvoiceRow[] = DEMO_INVOICES;
  let smsQueue: OutboundSmsQueueRow[] = [];

  if (isConfigured) {
    const supabase = await createClient();

    const { data } = await supabase
      .from("platform_subscription_invoices")
      .select(
        "id, wholesaler_id, billing_month, billed_retailer_count, full_month_fee, amount, status, paid_at, collected_by, memo, wholesalers:wholesaler_id ( business_name, business_number )"
      )
      .gte("billing_month", rangeFromMonth)
      .lte("billing_month", rangeToMonth)
      .order("billing_month", { ascending: false });

    type WholesalerInfo = { business_name: string; business_number: string };

    // supabase-js가 forward FK 임베드(wholesaler_id 기준 wholesalers)를 배열/단일 객체
    // 중 어느 쪽으로 추론할지 select 문자열만으로는 보장되지 않아 unknown을 거쳐 캐스팅하고,
    // 아래 매핑에서 두 모양 다 방어적으로 처리한다.
    const rows = (data ?? []) as unknown as Array<{
      id: string;
      wholesaler_id: string;
      billing_month: string;
      billed_retailer_count: number;
      full_month_fee: number;
      amount: number;
      status: "unpaid" | "paid";
      paid_at: string | null;
      collected_by: string | null;
      memo: string | null;
      wholesalers: WholesalerInfo | WholesalerInfo[] | null;
    }>;

    const collectorIds = Array.from(
      new Set(rows.map((row) => row.collected_by).filter((id): id is string => Boolean(id)))
    );

    const { data: profilesData } =
      collectorIds.length > 0
        ? await supabase.from("profiles").select("id, name").in("id", collectorIds)
        : { data: [] as Array<{ id: string; name: string | null }> };

    const nameMap = new Map(
      ((profilesData ?? []) as Array<{ id: string; name: string | null }>).map((row) => [
        row.id,
        row.name || "이름 미등록",
      ])
    );

    invoices = rows.map((row) => {
      const wholesalerInfo = Array.isArray(row.wholesalers) ? row.wholesalers[0] : row.wholesalers;

      return {
        id: row.id,
        wholesalerId: row.wholesaler_id,
        businessName: wholesalerInfo?.business_name ?? "알 수 없음",
        businessNumber: wholesalerInfo?.business_number ?? "-",
        billingMonth: row.billing_month,
        billedRetailerCount: row.billed_retailer_count,
        fullMonthFee: Number(row.full_month_fee),
        amount: Number(row.amount),
        status: row.status,
        paidAt: row.paid_at,
        collectedByName: row.collected_by ? nameMap.get(row.collected_by) ?? "알 수 없음" : null,
        memo: row.memo,
      };
    });

    const { data: queueRows } = await supabase
      .from("outbound_sms_queue")
      .select("id, recipient_name, recipient_phone, message_body, status, created_at")
      .eq("message_type", "billing_invoice")
      .order("created_at", { ascending: false });

    smsQueue = ((queueRows ?? []) as Array<{
      id: string;
      recipient_name: string;
      recipient_phone: string;
      message_body: string;
      status: "pending" | "sent";
      created_at: string;
    }>).map((row) => ({
      id: row.id,
      recipientName: row.recipient_name,
      recipientPhone: row.recipient_phone,
      messageBody: row.message_body,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  return (
    <main style={{ maxWidth: "960px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "24px" }}>
        <AdminNav />
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px", marginBottom: "8px" }}>
          구독료 청구·수납 관리
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6 }}>
          매달 1일 새벽 자동으로 지난달 청구서가 여기 확정돼서 쌓입니다(발주 취소 등으로
          나중에 원본이 바뀌어도 이미 확정된 금액은 그대로 유지됩니다). 이번 달은 아직
          확정 전이라 다음 달 초에 나타납니다 — 지금 진행 중인 잠정 금액은{" "}
          <Link href="/admin/suppliers" style={{ color: "#1d4ed8", textDecoration: "underline" }}>
            공급사 승인 화면
          </Link>
          에서 실시간으로 볼 수 있습니다.
        </p>
      </header>

      <div style={{ marginBottom: "20px" }}>
        <InvoiceSmsQueuePanel initialQueue={smsQueue} />
      </div>

      <BillingInvoiceList from={rangeFrom} to={rangeTo} initialInvoices={invoices} />
    </main>
  );
}
