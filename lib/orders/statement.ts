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
import { composeProductDisplayName } from "@/lib/products/display-name";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export interface StatementItem {
  productName: string;
  unitPrice: number;
  quantity: number;
  subtotalAmount: number;
}

/**
 * 명세서에 찍을 이력번호 1줄 = 실제로 나간 박스 하나.
 *
 * 축산물이력제상 판매 시 이력번호를 알려야 하는데, 지금까지는 출고 스캔으로
 * 어느 박스가 나갔는지 다 알면서도 명세서에는 안 찍혔다.
 */
export interface StatementTrace {
  productName: string;
  traceNo: string;
  quantity: number;
  grade: string | null;
  slaughterDate: string | null;
  butcheryPlace: string | null;
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
  /** 출고 스캔이 없었으면 확정 때 자동 배정된 박스가 들어온다. 없으면 빈 배열. */
  traces: StatementTrace[];
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
  category: string | null;
  unit_price: number | string;
  quantity: number | string;
  shipped_quantity: number | string | null;
  subtotal_amount: number | string;
};

type WholesalerRow = {
  business_name: string;
  business_number: string | null;
  representative_name: string;
  business_address: string | null;
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
    .select("product_name, category, unit_price, quantity, shipped_quantity, subtotal_amount")
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
      .select("business_name, business_number, representative_name, business_address, profile_id")
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
      address: w?.business_address ?? null,
      phone: (w?.profile_id && phoneByProfileId.get(w.profile_id)) || null,
    },
    buyer: {
      name: r?.restaurant_name ?? "고객(소매) 정보 미등록",
      representativeName: r?.representative_name ?? null,
      businessNumber: r?.business_number ?? null,
      address: r
        ? [r.delivery_address, r.delivery_address_detail].filter(Boolean).join(" ") || null
        : null,
      phone: (r?.profile_id && phoneByProfileId.get(r.profile_id)) || null,
    },
  };
}

/**
 * 실제로 나간 박스의 이력번호.
 *
 * 어느 박스가 나갔는지 고르는 기준(출고 스캔이 있으면 그것, 없으면 자동 배정)은
 * DB 함수가 갖고 있다 — 명세서와 화면이 서로 다른 답을 내지 않도록 한 곳에 둔다.
 * 인가도 그 함수 안에서 공급사/바이어 양쪽을 본다.
 */
async function fetchTraces(
  supabase: SupabaseServerClient,
  orderId: string
): Promise<StatementTrace[]> {
  const { data, error } = await supabase.rpc("get_order_trace_numbers", {
    p_order_id: orderId,
  });

  // 이력번호는 명세서의 부가 정보라, 못 불러왔다고 발행 자체를 막지는 않는다.
  if (error) {
    return [];
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    productName: String(row.product_name ?? ""),
    traceNo: String(row.trace_no ?? ""),
    quantity: Number(row.quantity ?? 0),
    grade: (row.grade as string | null) ?? null,
    slaughterDate: (row.slaughter_date as string | null) ?? null,
    butcheryPlace: (row.butchery_place as string | null) ?? null,
  }));
}

function toStatementData(
  order: OrderRow,
  items: OrderItemRow[],
  parties: { supplier: StatementParty; buyer: StatementParty },
  traces: StatementTrace[]
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
      productName: composeProductDisplayName(item.category, item.product_name),
      unitPrice: Number(item.unit_price),
      // 출고 마감이 끝났으면 실제 나간 양을 찍는다. 금액(subtotal_amount)도
      // 그때 같이 확정되므로 단가 × 수량이 항상 맞는다.
      quantity: Number(item.shipped_quantity ?? item.quantity),
      subtotalAmount: Number(item.subtotal_amount),
    })),
    traces,
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

  const [parties, traces] = await Promise.all([
    fetchParties(supabase, wholesalerId, core.order.retailer_id),
    fetchTraces(supabase, orderId),
  ]);

  return toStatementData(core.order, core.items, parties, traces);
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
    missing.push("공급사(도매) 사업장 주소");
  }

  return missing;
}

/**
 * 계산서(면세) 발행에 필요한 필수 정보 확인 — 거래명세서 조건(공급사 주소)에
 * 고객(소매) 사업자등록번호를 추가로 더한다.
 *
 * 계산서는 공급받는자 사업자등록번호 없이는 문서로서 의미가 없어 거래명세서보다
 * 기준이 하나 더 있다. 반대로 거래명세서는 비사업자 고객도 받는 문서라
 * findMissingStatementFields()는 그대로 두고 이 함수를 계산서 라우트에서만 쓴다.
 */
export function findMissingTaxInvoiceFields(data: StatementData): string[] {
  const missing = findMissingStatementFields(data);

  if (!data.buyer.businessNumber) {
    missing.push("고객(소매) 사업자등록번호");
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

  const [parties, traces] = await Promise.all([
    fetchParties(supabase, wholesalerId, retailerId),
    fetchTraces(supabase, orderId),
  ]);

  return toStatementData(core.order, core.items, parties, traces);
}
