/**
 * 거래명세서(PDF) 생성을 위한 주문 데이터 로더.
 *
 * 세금계산서(국세청 전자세금계산서)와 달리 거래명세서는 법정 증빙서류가 아니라
 * 상관례상 참고 문서라 별도 ASP 연동/사업자 위임 없이, 이미 DB에 있는 발주서
 * 데이터를 그대로 PDF로 변환하면 된다. 다만 부가세 신고용 증빙은 아니므로
 * PDF 본문에 그 취지를 명시한다(lib/pdf/transaction-statement.tsx 참고).
 *
 * 공급사(백오피스)/바이어(미니샵) 양쪽에서 같은 형태의 데이터가 필요해 로더를
 * 공유하되, 인가 조건(wholesaler_id만 / wholesaler_id+retailer_id 모두)만 다르게 받는다.
 */

import type { createClient } from "@/lib/supabase/server";
import type { OrderStatus } from "@/types/database";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export interface StatementItem {
  productName: string;
  unitPrice: number;
  quantity: number;
  subtotalAmount: number;
}

export interface StatementParty {
  name: string;
  representativeName: string | null;
  businessNumber: string | null;
  address: string | null;
  phone: string | null;
}

export interface StatementData {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  orderedAt: string;
  deliveryAddress: string;
  deliveryNotes: string | null;
  totalAmount: number;
  items: StatementItem[];
  supplier: StatementParty;
  buyer: StatementParty;
}

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  total_amount: number | string;
  delivery_address: string | null;
  delivery_notes: string | null;
  ordered_at: string;
  wholesaler_id: string;
  retailer_id: string;
};

type OrderItemRow = {
  product_name: string;
  unit_price: number | string;
  quantity: number | string;
  subtotal_amount: number | string;
};

type WholesalerRow = {
  business_name: string;
  business_number: string | null;
  representative_name: string;
  profile_id: string;
};

type RetailerRow = {
  restaurant_name: string;
  representative_name: string;
  business_number: string | null;
  delivery_address: string | null;
  delivery_address_detail: string | null;
  profile_id: string;
};

/**
 * 주문 1건 + 품목 조회. 인가 조건(wholesalerId, 선택적으로 retailerId)에 맞지 않으면 null.
 */
async function fetchOrderCore(
  supabase: SupabaseServerClient,
  orderId: string,
  wholesalerId: string,
  retailerId?: string
): Promise<{ order: OrderRow; items: OrderItemRow[] } | null> {
  let query = supabase
    .from("orders")
    .select(
      "id, order_number, status, total_amount, delivery_address, delivery_notes, ordered_at, wholesaler_id, retailer_id"
    )
    .eq("id", orderId)
    .eq("wholesaler_id", wholesalerId);

  if (retailerId) {
    query = query.eq("retailer_id", retailerId);
  }

  const { data: order } = await query.maybeSingle();

  if (!order) {
    return null;
  }

  const { data: items } = await supabase
    .from("order_items")
    .select("product_name, unit_price, quantity, subtotal_amount")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });

  return { order: order as OrderRow, items: (items ?? []) as OrderItemRow[] };
}

/** 공급사(wholesaler)/바이어(retailer) 사업자 정보 + 대표자 연락처(profiles.phone)를 함께 조회 */
async function fetchParties(
  supabase: SupabaseServerClient,
  wholesalerId: string,
  retailerId: string
): Promise<{ supplier: StatementParty; buyer: StatementParty }> {
  const [{ data: wholesaler }, { data: retailer }] = await Promise.all([
    supabase
      .from("wholesalers")
      .select("business_name, business_number, representative_name, profile_id")
      .eq("id", wholesalerId)
      .maybeSingle(),
    supabase
      .from("retailers")
      .select(
        "restaurant_name, representative_name, business_number, delivery_address, delivery_address_detail, profile_id"
      )
      .eq("id", retailerId)
      .maybeSingle(),
  ]);

  const w = wholesaler as WholesalerRow | null;
  const r = retailer as RetailerRow | null;

  const profileIds = [w?.profile_id, r?.profile_id].filter((id): id is string => Boolean(id));

  const { data: profiles } = profileIds.length
    ? await supabase.from("profiles").select("id, phone").in("id", profileIds)
    : { data: [] as Array<{ id: string; phone: string | null }> };

  const phoneByProfileId = new Map(
    ((profiles ?? []) as Array<{ id: string; phone: string | null }>).map((p) => [p.id, p.phone])
  );

  return {
    supplier: {
      name: w?.business_name ?? "공급사 정보 미등록",
      representativeName: w?.representative_name ?? null,
      businessNumber: w?.business_number ?? null,
      address: null, // wholesalers 테이블에 사업장 주소 컬럼이 아직 없음
      phone: (w?.profile_id && phoneByProfileId.get(w.profile_id)) || null,
    },
    buyer: {
      name: r?.restaurant_name ?? "바이어 정보 미등록",
      representativeName: r?.representative_name ?? null,
      businessNumber: r?.business_number ?? null,
      address: r
        ? [r.delivery_address, r.delivery_address_detail].filter(Boolean).join(" ") || null
        : null,
      phone: (r?.profile_id && phoneByProfileId.get(r.profile_id)) || null,
    },
  };
}

function toStatementData(
  order: OrderRow,
  items: OrderItemRow[],
  parties: { supplier: StatementParty; buyer: StatementParty }
): StatementData {
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    status: order.status as OrderStatus,
    orderedAt: order.ordered_at,
    deliveryAddress: order.delivery_address ?? "",
    deliveryNotes: order.delivery_notes,
    totalAmount: Number(order.total_amount),
    items: items.map((item) => ({
      productName: item.product_name,
      unitPrice: Number(item.unit_price),
      quantity: Number(item.quantity),
      subtotalAmount: Number(item.subtotal_amount),
    })),
    supplier: parties.supplier,
    buyer: parties.buyer,
  };
}

/** 공급사(백오피스) 인가 — wholesalerId 소유 주문인지만 확인 */
export async function loadStatementDataForSupplier(
  supabase: SupabaseServerClient,
  orderId: string,
  wholesalerId: string
): Promise<StatementData | null> {
  const core = await fetchOrderCore(supabase, orderId, wholesalerId);

  if (!core) {
    return null;
  }

  const parties = await fetchParties(supabase, wholesalerId, core.order.retailer_id);

  return toStatementData(core.order, core.items, parties);
}

/**
 * 발행에 필요한 필수 정보가 다 갖춰졌는지 확인한다.
 *
 * wholesalers.business_address는 2026-09-25 마이그레이션으로 새로 추가된
 * 컬럼이라 기존 레코드는 NULL로 남아 있다. 이걸 그냥 '-'로 조용히 인쇄하면
 * 실사용자가 빈 문서를 정상 문서로 착각할 수 있어, 라우트 핸들러가 반드시
 * 이 함수로 먼저 확인한 뒤 비어 있으면 발행 자체를 막아야 한다.
 */
export function findMissingStatementFields(data: StatementData): string[] {
  const missing: string[] = [];

  if (!data.supplier.address) {
    missing.push("공급자(도매업자) 사업장 주소");
  }

  return missing;
}

/** 바이어(미니샵) 인가 — wholesalerId + retailerId 둘 다 일치해야 함(교차 조회 차단) */
export async function loadStatementDataForBuyer(
  supabase: SupabaseServerClient,
  orderId: string,
  wholesalerId: string,
  retailerId: string
): Promise<StatementData | null> {
  const core = await fetchOrderCore(supabase, orderId, wholesalerId, retailerId);

  if (!core) {
    return null;
  }

  const parties = await fetchParties(supabase, wholesalerId, retailerId);

  return toStatementData(core.order, core.items, parties);
}
