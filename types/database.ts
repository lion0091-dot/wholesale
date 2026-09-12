export type UserRole = "super_admin" | "wholesaler" | "retailer";

export type WholesalerStatus = "pending" | "active" | "suspended" | "rejected";
export type SubscriptionStatus = "trial" | "active" | "overdue" | "cancelled";
export type RelationshipStatus = "active" | "blocked";
export type OrderStatus =
  | "pending"
  | "confirmed"
  | "shipping"
  | "delivered"
  | "cancel_requested"
  | "cancel_rejected"
  | "cancelled";

export interface Profile {
  id: string;
  role: UserRole;
  name: string;
  phone: string;
  created_at: string;
  updated_at: string;
}

export interface Wholesaler {
  id: string;
  profile_id: string;
  business_name: string;
  business_number: string;
  representative_name: string;
  shop_token: string;
  status: WholesalerStatus;
  subscription_status: SubscriptionStatus;
  created_at: string;
  updated_at: string;
}

export interface Retailer {
  id: string;
  profile_id: string;
  restaurant_name: string;
  business_number: string | null;
  representative_name: string;
  delivery_address: string;
  delivery_address_detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  wholesaler_id: string;
  name: string;
  category: string;
  origin: string;
  grade: string | null;
  base_price: number;
  unit: string;
  stock_quantity: number;
  is_secret_deal: boolean;
  is_active: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomPrice {
  id: string;
  wholesaler_id: string;
  retailer_id: string;
  product_id: string;
  custom_price: number;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  wholesaler_id: string;
  retailer_id: string;
  order_number: string;
  total_amount: number;
  status: OrderStatus;
  delivery_address: string;
  delivery_notes: string | null;
  ordered_at: string;
  updated_at: string;
  /**
   * 취소 요청 메타데이터 (마이그레이션 20260912000000에서 추가).
   * 취소 흐름을 거치지 않은 주문과 컬럼 추가 이전 데이터에서는 비어 있다.
   */
  cancel_reason?: string | null;
  cancel_requested_at?: string | null;
  cancel_resolved_at?: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  subtotal_amount: number;
  created_at: string;
}
