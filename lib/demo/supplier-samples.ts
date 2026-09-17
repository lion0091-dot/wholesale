import type {
  Order,
  OrderItem,
  Product,
  RelationshipStatus,
} from "@/types/database";

/**
 * Supabase 미설정/미인증(데모 모드)에서 백오피스 UI를 시연하기 위한 샘플 데이터.
 * id는 데모 전용 문자열이므로 실제 Server Action 호출 시 검증 단계에서 거부된다.
 */
const now = () => new Date().toISOString();

export const DEMO_PRODUCTS: Product[] = [
  {
    id: "sample-1",
    wholesaler_id: "demo-wholesaler-id",
    name: "한우 1++ 등심",
    category: "소",
    origin: "국내산",
    grade: "1++ (No.9)",
    base_price: 85000,
    unit: "kg",
    stock_quantity: 12.5,
    is_secret_deal: false,
    is_active: true,
    description: "최고급 마블링 냉장 숙성 등심, 진공포장 출고",
    created_at: now(),
    updated_at: now(),
    created_by: null,
    updated_by: null,
  },
  {
    id: "sample-2",
    wholesaler_id: "demo-wholesaler-id",
    name: "국내산 암퇘지 삼겹살",
    category: "돼지",
    origin: "국내산",
    grade: "1등급",
    base_price: 18500,
    unit: "kg",
    stock_quantity: 45,
    is_secret_deal: false,
    is_active: true,
    description: "미추리 선별 완료, 탕박 A급 규격돈",
    created_at: now(),
    updated_at: now(),
    created_by: null,
    updated_by: null,
  },
  {
    id: "sample-3",
    wholesaler_id: "demo-wholesaler-id",
    name: "[마감임박 특가] 한우 사태/양지 믹스",
    category: "소",
    origin: "국내산",
    grade: "1등급",
    base_price: 29000,
    unit: "kg",
    stock_quantity: 2,
    is_secret_deal: true,
    is_active: true,
    description: "국거리 및 육수용 당일 한정 수량 소진 특가 (단골 전용)",
    created_at: now(),
    updated_at: now(),
    created_by: null,
    updated_by: null,
  },
];

export interface DemoRetailer {
  id: string;
  restaurant_name: string;
  business_number: string | null;
  representative_name: string;
  delivery_address: string;
  delivery_address_detail: string | null;
  /** 거래 관계(wholesaler_retailers) 상태 및 메모 */
  status: RelationshipStatus;
  memo: string | null;
  created_at: string;
  /** 여신 한도 (0이면 외상 거래 불가) */
  credit_limit: number;
  outstanding_balance: number;
  settlement_due_days: number;
}

export const DEMO_RETAILERS: DemoRetailer[] = [
  {
    id: "demo-retailer-1",
    restaurant_name: "을지로 한우마을 (구매 회원)",
    business_number: "204-81-33215",
    representative_name: "김성호",
    delivery_address: "서울 중구 을지로 123길 45",
    delivery_address_detail: "1층 주방 뒷문",
    status: "active",
    memo: "매주 화/금 오전 6시 이전 납품 요청",
    created_at: "2026-06-14T02:10:00.000Z",
    credit_limit: 0,
    outstanding_balance: 0,
    settlement_due_days: 30,
  },
  {
    id: "demo-retailer-2",
    restaurant_name: "성수 정육식당",
    business_number: "110-22-45789",
    representative_name: "박영자",
    delivery_address: "서울 성동구 성수일로 89",
    delivery_address_detail: "지하 1층",
    status: "active",
    memo: "세금계산서 월말 일괄 발행",
    created_at: "2026-07-02T05:30:00.000Z",
    credit_limit: 500000,
    outstanding_balance: 185000,
    settlement_due_days: 30,
  },
  {
    id: "demo-retailer-3",
    restaurant_name: "마포 갈비천국",
    business_number: null,
    representative_name: "이정훈",
    delivery_address: "서울 마포구 도화동 12-3",
    delivery_address_detail: null,
    status: "blocked",
    memo: "미수금 정산 후 거래 재개 예정",
    created_at: "2026-08-21T01:05:00.000Z",
    credit_limit: 200000,
    outstanding_balance: 0,
    settlement_due_days: 14,
  },
];

export interface DemoCustomPrice {
  id: string;
  retailer_id: string;
  product_id: string;
  custom_price: number;
  updated_at: string;
}

export const DEMO_CUSTOM_PRICES: DemoCustomPrice[] = [
  {
    id: "demo-cp-1",
    retailer_id: "demo-retailer-1",
    product_id: "sample-1",
    custom_price: 79000,
    updated_at: now(),
  },
  {
    id: "demo-cp-2",
    retailer_id: "demo-retailer-2",
    product_id: "sample-2",
    custom_price: 17800,
    updated_at: now(),
  },
];

/** 주문 목록/상세 데모용 — Order + 발주처 상호 + 품목 스냅샷 */
export interface DemoOrder extends Order {
  retailer_name: string;
  items: OrderItem[];
}

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000).toISOString();

function demoItem(
  index: number,
  orderId: string,
  productId: string,
  productName: string,
  unitPrice: number,
  quantity: number
): OrderItem {
  return {
    id: `${orderId}-item-${index}`,
    order_id: orderId,
    product_id: productId,
    product_name: productName,
    unit_price: unitPrice,
    quantity,
    subtotal_amount: Math.round(unitPrice * quantity),
    created_at: minutesAgo(0),
  };
}

export const DEMO_ORDERS: DemoOrder[] = [
  {
    id: "demo-order-1",
    wholesaler_id: "demo-wholesaler-id",
    retailer_id: "demo-retailer-1",
    retailer_name: "을지로 한우마을 (구매 회원)",
    order_number: "ORD-20260911-A79B2C",
    total_amount: 255000,
    status: "pending",
    payment_method: "prepaid",
    delivery_address: "서울 중구 을지로 123길 45, 1층 주방",
    delivery_notes: "내일 오전 6시 전까지 주방 뒷문 보냉박스에 넣어주세요.",
    ordered_at: minutesAgo(25),
    updated_at: minutesAgo(25),
    items: [
      demoItem(1, "demo-order-1", "sample-1", "한우 1++ 등심", 85000, 2),
      demoItem(2, "demo-order-1", "sample-3", "[마감임박 특가] 한우 사태/양지 믹스", 29000, 2),
      demoItem(3, "demo-order-1", "sample-2", "국내산 암퇘지 삼겹살", 18500, 1.5),
    ],
  },
  {
    id: "demo-order-2",
    wholesaler_id: "demo-wholesaler-id",
    retailer_id: "demo-retailer-2",
    retailer_name: "성수 정육식당",
    order_number: "ORD-20260911-E54D1F",
    total_amount: 185000,
    status: "confirmed",
    payment_method: "on_credit",
    delivery_address: "서울 성동구 성수일로 89, 지하 1층",
    delivery_notes: "세금계산서 발행 완료 부탁드립니다.",
    ordered_at: minutesAgo(190),
    updated_at: minutesAgo(120),
    items: [demoItem(1, "demo-order-2", "sample-2", "국내산 암퇘지 삼겹살", 18500, 10)],
  },
  {
    id: "demo-order-3",
    wholesaler_id: "demo-wholesaler-id",
    retailer_id: "demo-retailer-1",
    retailer_name: "을지로 한우마을 (구매 회원)",
    order_number: "ORD-20260910-77C019",
    total_amount: 316000,
    status: "shipping",
    payment_method: "prepaid",
    delivery_address: "서울 중구 을지로 123길 45, 1층 주방",
    delivery_notes: null,
    ordered_at: minutesAgo(1380),
    updated_at: minutesAgo(300),
    items: [
      demoItem(1, "demo-order-3", "sample-1", "한우 1++ 등심", 79000, 4),
    ],
  },
  {
    id: "demo-order-4",
    wholesaler_id: "demo-wholesaler-id",
    retailer_id: "demo-retailer-3",
    retailer_name: "마포 갈비천국",
    order_number: "ORD-20260909-B21A08",
    total_amount: 92500,
    status: "delivered",
    payment_method: "prepaid",
    delivery_address: "서울 마포구 도화동 12-3",
    delivery_notes: "정문 앞에 두고 전화 주세요.",
    ordered_at: minutesAgo(2900),
    updated_at: minutesAgo(2600),
    items: [demoItem(1, "demo-order-4", "sample-2", "국내산 암퇘지 삼겹살", 18500, 5)],
  },
  {
    id: "demo-order-5",
    wholesaler_id: "demo-wholesaler-id",
    retailer_id: "demo-retailer-3",
    retailer_name: "마포 갈비천국",
    order_number: "ORD-20260908-4D9E71",
    total_amount: 58000,
    status: "cancelled",
    payment_method: "prepaid",
    delivery_address: "서울 마포구 도화동 12-3",
    delivery_notes: null,
    ordered_at: minutesAgo(4300),
    updated_at: minutesAgo(4200),
    items: [
      demoItem(1, "demo-order-5", "sample-3", "[마감임박 특가] 한우 사태/양지 믹스", 29000, 2),
    ],
  },
];
