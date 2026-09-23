/**
 * 배송의뢰서(PDF) 생성을 위한 주문 데이터 로더.
 *
 * 거래명세서와 달리 가격 정보는 담지 않는다 — 화물기사님/택배사에 전달할
 * "무엇을 얼마나 어디로 보내는지"만 필요하다. 운송장 자동 발급 API가 없는
 * 공급사도 이 문서로 전화/카톡 의뢰 시 타이핑을 줄일 수 있다(docs/delivery-tracking.md
 * 의 "운송장 발급 대행 아님" 원칙은 그대로 유지 — 이 문서는 발급을 대행하지 않고
 * 의뢰 내용만 정리해줄 뿐이다).
 */

import type { createClient } from "@/lib/supabase/server";
import { composeProductDisplayName } from "@/lib/products/display-name";
import type { StatementParty } from "@/lib/orders/statement";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export interface DeliveryRequestItem {
  productName: string;
  quantity: number;
  unit: string;
}

export interface DeliveryRequestData {
  orderId: string;
  orderNumber: string;
  orderedAt: string;
  deliveryAddress: string;
  deliveryNotes: string | null;
  items: DeliveryRequestItem[];
  /** kg 단위 품목만 합산한 참고용 총 중량. kg 품목이 하나도 없으면 null. */
  totalWeightKg: number | null;
  sender: StatementParty;
  receiver: StatementParty;
}

type OrderRow = {
  id: string;
  order_number: string;
  delivery_address: string | null;
  delivery_notes: string | null;
  ordered_at: string;
  wholesaler_id: string;
  retailer_id: string;
};

type OrderItemRow = {
  product_name: string;
  category: string | null;
  quantity: number | string;
  shipped_quantity: number | string | null;
  products: { unit: string } | { unit: string }[] | null;
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

function firstOrSelf<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

async function fetchParties(
  supabase: SupabaseServerClient,
  wholesalerId: string,
  retailerId: string
): Promise<{ sender: StatementParty; receiver: StatementParty }> {
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
    sender: {
      name: w?.business_name ?? "공급사 정보 미등록",
      representativeName: w?.representative_name ?? null,
      businessNumber: w?.business_number ?? null,
      address: w?.business_address ?? null,
      phone: (w?.profile_id && phoneByProfileId.get(w.profile_id)) || null,
    },
    receiver: {
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

/** 공급사(백오피스) 인가 — wholesalerId 소유 주문인지만 확인 */
export async function loadDeliveryRequestDataForSupplier(
  supabase: SupabaseServerClient,
  orderId: string,
  wholesalerId: string
): Promise<DeliveryRequestData | null> {
  const { data: order } = await supabase
    .from("orders")
    .select("id, order_number, delivery_address, delivery_notes, ordered_at, wholesaler_id, retailer_id")
    .eq("id", orderId)
    .eq("wholesaler_id", wholesalerId)
    .maybeSingle();

  if (!order) {
    return null;
  }

  const orderRow = order as OrderRow;

  const [{ data: itemRows }, parties] = await Promise.all([
    supabase
      .from("order_items")
      .select("product_name, category, quantity, shipped_quantity, products ( unit )")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    fetchParties(supabase, wholesalerId, orderRow.retailer_id),
  ]);

  const items: DeliveryRequestItem[] = ((itemRows ?? []) as OrderItemRow[]).map((row) => {
    const product = firstOrSelf(row.products);

    return {
      productName: composeProductDisplayName(row.category, row.product_name),
      // 출고 마감이 끝났으면 실제 나간 양을 찍는다(statement.ts와 동일 원칙).
      quantity: Number(row.shipped_quantity ?? row.quantity),
      unit: product?.unit ?? "",
    };
  });

  const totalWeightKg = items
    .filter((item) => item.unit === "kg")
    .reduce((sum, item) => sum + item.quantity, 0);

  return {
    orderId: orderRow.id,
    orderNumber: orderRow.order_number,
    orderedAt: orderRow.ordered_at,
    deliveryAddress: orderRow.delivery_address ?? "",
    deliveryNotes: orderRow.delivery_notes,
    items,
    totalWeightKg: totalWeightKg > 0 ? totalWeightKg : null,
    sender: parties.sender,
    receiver: parties.receiver,
  };
}

/**
 * 발급에 필요한 최소 정보 확인 — 거래명세서와 같은 이유로 발송인(공급사) 사업장
 * 주소가 없으면 빈 문서를 정상 문서로 착각할 수 있어 발행 자체를 막는다.
 */
export function findMissingDeliveryRequestFields(data: DeliveryRequestData): string[] {
  const missing: string[] = [];

  if (!data.sender.address) {
    missing.push("공급사(도매) 사업장 주소");
  }

  return missing;
}
