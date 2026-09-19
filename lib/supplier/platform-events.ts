/**
 * 플랫폼 마케팅/할인 이벤트 — 구독료에 적용되는 할인율 조회 전용 모듈.
 *
 * 이벤트 자체의 CRUD는 app/admin/events/actions.ts가 담당한다(super_admin 전용,
 * 생성 후 수정 불가·취소만 가능). 이 파일은 "이번 달 이 공급사에게 적용되는 할인율이
 * 얼마인지"만 계산한다. 두 가지 조회 경로가 있다:
 *
 * - getActiveEventDiscount(): 공급사 본인 화면(/dashboard/billing)에서 쓴다. 일반
 *   공급사 계정은 platform_event_suppliers(개별 이벤트 매핑)를 직접 SELECT할 권한이
 *   없으므로(super_admin 전용 RLS), security definer RPC(get_active_event_discount)로
 *   우회 조회한다.
 * - listActiveEventsForMonth() + resolveDiscountForWholesaler(): 관리자 목록
 *   (/admin/suppliers)에서 쓴다. super_admin은 두 테이블 모두 직접 SELECT 가능하므로,
 *   공급사 수만큼 RPC를 반복 호출하지 않고 한 번에 조회한 뒤 메모리에서 합성한다.
 */

import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC ISO 타임스탬프를 KST 기준 'YYYY-MM-DD' 날짜 문자열로. */
function toKstDateString(isoUtc: string): string {
  return new Date(new Date(isoUtc).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' 문자열을 UTC 자정 타임스탬프로. 순수 날짜 비교/연산용(시간대 보정 불필요). */
function toUtcMidnight(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getTime();
}

function daysBetween(startDateStr: string, endDateStr: string): number {
  return Math.round((toUtcMidnight(endDateStr) - toUtcMidnight(startDateStr)) / DAY_MS);
}

function addDays(dateStr: string, days: number): string {
  return new Date(toUtcMidnight(dateStr) + days * DAY_MS).toISOString().slice(0, 10);
}

export interface ActiveEventDiscount {
  /** 0~100 사이 퍼센트. 겹치는 이벤트가 있으면 합산 후 100 상한. */
  discountRate: number;
  /** 적용 중인 이벤트 이름(여러 개면 " + "로 연결). 없으면 null. */
  eventName: string | null;
}

const EMPTY_DISCOUNT: ActiveEventDiscount = { discountRate: 0, eventName: null };

/** 공급사 본인 화면용 — RPC로 우회 조회(individual 이벤트 매핑도 포함). */
export async function getActiveEventDiscount(
  supabase: SupabaseServerClient,
  wholesalerId: string,
  monthRangeUtc: { startUtc: string; endUtc: string }
): Promise<ActiveEventDiscount> {
  const { data } = await supabase
    .rpc("get_active_event_discount", {
      p_wholesaler_id: wholesalerId,
      p_month_start: toKstDateString(monthRangeUtc.startUtc),
      p_month_end_exclusive: toKstDateString(monthRangeUtc.endUtc),
    })
    .maybeSingle();

  const row = data as { discount_rate: number | null; event_name: string | null } | null;

  if (!row) {
    return EMPTY_DISCOUNT;
  }

  return {
    discountRate: Number(row.discount_rate ?? 0),
    eventName: row.event_name ?? null,
  };
}

interface PlatformEventRow {
  id: string;
  name: string;
  discount_rate: number;
  event_type: "common" | "individual";
  starts_on: string;
  ends_on: string;
}

export interface ActiveEventsSnapshot {
  events: PlatformEventRow[];
  /** event_id → (wholesaler_id → override 할인율(null이면 이벤트 기본값)) */
  supplierOverrides: Map<string, Map<string, number | null>>;
  /** 이번 달 KST 경계 — resolveDiscountForWholesaler가 겹친 일수 비율을 계산할 때 쓴다. */
  monthStart: string;
  monthEndExclusive: string;
}

/** 관리자 목록 화면용 — 이번 달과 겹치는 활성 이벤트 전체를 한 번에 조회. */
export async function listActiveEventsForMonth(
  supabase: SupabaseServerClient,
  monthRangeUtc: { startUtc: string; endUtc: string }
): Promise<ActiveEventsSnapshot> {
  const monthStart = toKstDateString(monthRangeUtc.startUtc);
  const monthEndExclusive = toKstDateString(monthRangeUtc.endUtc);

  const { data: events } = await supabase
    .from("platform_events")
    .select("id, name, discount_rate, event_type, starts_on, ends_on")
    .eq("status", "active")
    .lt("starts_on", monthEndExclusive)
    .gte("ends_on", monthStart);

  const eventRows = (events ?? []) as PlatformEventRow[];
  const individualEventIds = eventRows
    .filter((event) => event.event_type === "individual")
    .map((event) => event.id);

  const supplierOverrides = new Map<string, Map<string, number | null>>();

  if (individualEventIds.length > 0) {
    const { data: mappings } = await supabase
      .from("platform_event_suppliers")
      .select("event_id, wholesaler_id, discount_rate")
      .in("event_id", individualEventIds);

    for (const row of (mappings ?? []) as Array<{
      event_id: string;
      wholesaler_id: string;
      discount_rate: number | null;
    }>) {
      if (!supplierOverrides.has(row.event_id)) {
        supplierOverrides.set(row.event_id, new Map());
      }

      supplierOverrides.get(row.event_id)!.set(row.wholesaler_id, row.discount_rate);
    }
  }

  return { events: eventRows, supplierOverrides, monthStart, monthEndExclusive };
}

/**
 * listActiveEventsForMonth 결과에서 특정 공급사에게 적용되는 할인율/이벤트명을 합성.
 *
 * 이벤트 기간이 이번 달과 일부만 겹치면(예: 30일짜리 달에 10일만 겹침) 할인율을 겹친
 * 일수 비율만큼 희석해서 더한다 — get_active_event_discount RPC(공급사 본인 화면용)와
 * 동일한 계산 원칙을 여기(관리자 목록용)서도 맞춘다.
 */
export function resolveDiscountForWholesaler(
  wholesalerId: string,
  snapshot: ActiveEventsSnapshot
): ActiveEventDiscount {
  const monthDays = daysBetween(snapshot.monthStart, snapshot.monthEndExclusive);
  let total = 0;
  const names: string[] = [];

  for (const event of snapshot.events) {
    let baseRate: number | null = null;

    if (event.event_type === "common") {
      baseRate = event.discount_rate;
    } else {
      const overrideMap = snapshot.supplierOverrides.get(event.id);

      if (overrideMap?.has(wholesalerId)) {
        baseRate = overrideMap.get(wholesalerId) ?? event.discount_rate;
      }
    }

    if (baseRate === null || baseRate <= 0) {
      continue;
    }

    const overlapStart = event.starts_on > snapshot.monthStart ? event.starts_on : snapshot.monthStart;
    const eventEndExclusive = addDays(event.ends_on, 1);
    const overlapEndExclusive =
      eventEndExclusive < snapshot.monthEndExclusive ? eventEndExclusive : snapshot.monthEndExclusive;
    const overlapDays = Math.max(0, daysBetween(overlapStart, overlapEndExclusive));

    if (overlapDays <= 0) {
      continue;
    }

    total += baseRate * (overlapDays / monthDays);
    names.push(event.name);
  }

  if (names.length === 0) {
    return EMPTY_DISCOUNT;
  }

  return { discountRate: Math.min(100, total), eventName: names.join(" + ") };
}
