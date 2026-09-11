import type { RelationshipStatus } from "@/types/database";

/** 고객 관리 화면(카드 그리드 / 목록 테이블)이 공유하는 바이어 행 모델 */
export interface CustomerRow {
  id: string;
  restaurantName: string;
  representativeName: string;
  businessNumber: string | null;
  deliveryAddress: string;
  relationStatus: RelationshipStatus;
  memo: string | null;
  joinedAt: string;
  /** 맞춤 단가가 지정된 상품 수 (0이면 기본 단가 적용) */
  customPriceCount: number;
  orderCount: number;
  lastOrderedAt: string | null;
  totalOrderAmount: number;
}
