export type UserRole = "super_admin" | "wholesaler" | "retailer";

export type WholesalerStatus = "pending" | "active" | "suspended" | "rejected" | "closed";
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
export type PaymentMethod = "prepaid" | "on_credit";

export interface Profile {
  id: string;
  role: UserRole;
  name: string;
  phone: string;
  /** 공급사(도매) 계정 여부 — 카카오 가입 직후 트리거가 true로 생성한다. */
  is_supplier: boolean;
  /** 회사 승인 + 사업자 검증 완료 여부. false면 초대장 발부만 차단된다. */
  is_verified: boolean;
  /** 필수 약관 동의 시각. null이면 최소 정보 입력(온보딩 1단계) 전이다. */
  terms_agreed_at: string | null;
  privacy_agreed_at: string | null;
  marketing_agreed_at: string | null;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Wholesaler {
  id: string;
  profile_id: string;
  business_name: string;
  /** 가입 시점에는 미제출(null)일 수 있다. 승인 심사 단계에서 제출받는다. */
  business_number: string | null;
  representative_name: string;
  /**
   * 사업장 소재지. 온보딩에서 받지 않아 기존 레코드는 NULL일 수 있다 —
   * 거래명세서 PDF 발행 전 /dashboard/invites에서 직접 등록해야 한다.
   */
  business_address: string | null;
  /** 개업일자. 국세청 진위확인 API 호출에 필수 — 미제출이면 null. */
  business_start_date: string | null;
  /** 국세청 진위확인 API 결과. 입점 승인(status=active)은 'match'일 때만 허용한다. */
  nts_verification_status: "unchecked" | "match" | "mismatch" | "not_found" | "error";
  nts_verified_at: string | null;
  /** 사업자등록증 사본 Storage 경로. null이면 미제출 — 실제 조회는 서명된 URL로만. */
  business_license_path: string | null;
  business_license_uploaded_at: string | null;
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
  /** 부위 (예: 등심, 삼겹살) — product_subcategories 시드값, 자유 텍스트 아님. 기존 상품은 null일 수 있다. */
  subcategory: string | null;
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
  /** 최초 등록한 계정(auth.uid()) — 여러 직원이 쓰는 백오피스의 등록자 추적용 */
  created_by: string | null;
  /** 마지막으로 수정한 계정 */
  updated_by: string | null;
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
  payment_method: PaymentMethod;
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
  /**
   * 외상(on_credit) 주문 정산 완료 시각 (마이그레이션 20260915040000에서 추가).
   * NULL이면 미정산. prepaid 주문에는 의미가 없다.
   */
  settled_at?: string | null;
}

/** 플랫폼 관리자 allowlist 항목 (public.platform_admin_allowlist 행 그대로). */
export interface PlatformAdminAllowlistEntry {
  id: string;
  user_id: string;
  /** 관리자 명단 편집 권한 (2단 권한의 상위 등급). */
  can_grant: boolean;
  /** 부여 경로 — 사람이 부여한 권한과 자동 부트스트랩을 감사에서 구분한다. */
  source: "admin_grant" | "env_root" | "migration_backfill";
  note: string | null;
  granted_by: string | null;
  /** null이면 활성. */
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
  updated_at: string;
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
