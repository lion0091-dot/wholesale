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
  /** 여신 한도 (0이면 외상 거래 불가) */
  creditLimit: number;
  outstandingBalance: number;
  /** 연체 기준일 — 주문일로부터 이 일수가 지나면 미수금 정산 화면에서 연체로 표시 */
  settlementDueDays: number;
  /** 공급사가 이 거래처에 열어준 결제수단('prepaid'/'on_credit'/'pg') */
  allowedPaymentMethods: string[];
  /** 거래처 담당자 연락처 — "문자로 바로 보내기" 딥링크용. 조회 실패 시 null */
  contactPhone: string | null;
}
