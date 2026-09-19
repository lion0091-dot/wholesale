import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { EventManager, type PlatformEventRow, type SupplierOption } from "./event-manager";

const DEMO_SUPPLIERS: SupplierOption[] = [
  { id: "demo-wholesaler-1", businessName: "마장동 태양축산 (테스트 공급사)" },
  { id: "demo-wholesaler-2", businessName: "독산동 한우유통 (신규 신청)" },
  { id: "demo-wholesaler-3", businessName: "가락 미트센터 (미납 업체)" },
];

const DEMO_EVENTS: PlatformEventRow[] = [
  {
    id: "demo-event-1",
    name: "미트파트너스 오픈 1주년 기념",
    discountRate: 20,
    eventType: "common",
    startsOn: new Date().toISOString().slice(0, 10),
    endsOn: new Date(Date.now() + 1000 * 60 * 60 * 24 * 29).toISOString().slice(0, 10),
    durationDays: 30,
    status: "active",
    createdByName: "샘플 관리자",
    createdAt: new Date().toISOString(),
    cancelledByName: null,
    cancelledAt: null,
    targets: [],
  },
];

export default async function AdminEventsPage() {
  const isConfigured = isSupabaseConfigured();

  if (isConfigured && !(await isSuperAdminSession())) {
    redirect("/login?next=/admin/events");
  }

  let suppliers: SupplierOption[] = DEMO_SUPPLIERS;
  let events: PlatformEventRow[] = DEMO_EVENTS;

  if (isConfigured) {
    const supabase = await createClient();

    const [{ data: wholesalersData }, { data: eventsData }, { data: mappingsData }] = await Promise.all([
      supabase.from("wholesalers").select("id, business_name").order("business_name"),
      supabase
        .from("platform_events")
        .select(
          "id, name, discount_rate, event_type, starts_on, ends_on, duration_days, status, created_by, created_at, cancelled_by, cancelled_at"
        )
        .order("created_at", { ascending: false }),
      supabase.from("platform_event_suppliers").select("event_id, wholesaler_id, discount_rate"),
    ]);

    suppliers = ((wholesalersData ?? []) as Array<{ id: string; business_name: string }>).map((row) => ({
      id: row.id,
      businessName: row.business_name,
    }));

    const wholesalerNameMap = new Map(suppliers.map((s) => [s.id, s.businessName]));

    const userIds = Array.from(
      new Set(
        ((eventsData ?? []) as Array<{ created_by: string | null; cancelled_by: string | null }>).flatMap((row) =>
          [row.created_by, row.cancelled_by].filter((id): id is string => Boolean(id))
        )
      )
    );

    const { data: profilesData } =
      userIds.length > 0
        ? await supabase.from("profiles").select("id, name").in("id", userIds)
        : { data: [] as Array<{ id: string; name: string | null }> };

    const nameMap = new Map(
      ((profilesData ?? []) as Array<{ id: string; name: string | null }>).map((row) => [
        row.id,
        row.name || "이름 미등록",
      ])
    );

    const mappingsByEvent = new Map<string, Array<{ wholesaler_id: string; discount_rate: number | null }>>();

    for (const mapping of (mappingsData ?? []) as Array<{
      event_id: string;
      wholesaler_id: string;
      discount_rate: number | null;
    }>) {
      if (!mappingsByEvent.has(mapping.event_id)) {
        mappingsByEvent.set(mapping.event_id, []);
      }
      mappingsByEvent.get(mapping.event_id)!.push(mapping);
    }

    events = (
      (eventsData ?? []) as Array<{
        id: string;
        name: string;
        discount_rate: number;
        event_type: "common" | "individual";
        starts_on: string;
        ends_on: string;
        duration_days: number;
        status: "active" | "cancelled";
        created_by: string | null;
        created_at: string;
        cancelled_by: string | null;
        cancelled_at: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      name: row.name,
      discountRate: Number(row.discount_rate),
      eventType: row.event_type,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      durationDays: row.duration_days,
      status: row.status,
      createdByName: row.created_by ? nameMap.get(row.created_by) ?? "알 수 없음" : "시스템",
      createdAt: row.created_at,
      cancelledByName: row.cancelled_by ? nameMap.get(row.cancelled_by) ?? "알 수 없음" : null,
      cancelledAt: row.cancelled_at,
      targets: (mappingsByEvent.get(row.id) ?? []).map((mapping) => ({
        wholesalerId: mapping.wholesaler_id,
        businessName: wholesalerNameMap.get(mapping.wholesaler_id) ?? "알 수 없음",
        discountRate: mapping.discount_rate,
      })),
    }));
  }

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "24px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px", marginBottom: "8px" }}>
          구독료 할인 이벤트
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6 }}>
          전체 공급사 공통 또는 특정 업체 개별로 구독료 할인 이벤트를 만듭니다. 한 번 만들면
          내용은 고정이며(수정 불가), 취소만 가능합니다 — 아래 목록이 곧 전체 이력입니다.
          공통 이벤트는 대문에도 배너로 노출됩니다.
        </p>
      </header>

      <EventManager suppliers={suppliers} initialEvents={events} />
    </main>
  );
}
