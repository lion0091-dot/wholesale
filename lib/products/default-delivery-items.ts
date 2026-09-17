/**
 * 공급사 온보딩용 '기본 납품 품목' 시드 세트.
 *
 * 상품을 한 건도 등록하지 않은 공급사는 미니샵이 데모 카탈로그로 대체되어
 * 실제 발주를 받을 수 없다. 백오피스에서 이 세트를 한 번 생성하면
 * 바로 미니샵 '기본 납품 품목' 탭에 노출되는 실 데이터가 된다.
 *
 * products 테이블 컬럼과 1:1로 맞춘 순수 데이터(서버/클라이언트 공용).
 * 시크릿 딜은 포함하지 않는다 — 기본 납품 품목은 전체 공개 품목이다.
 */

export interface DefaultDeliveryItem {
  name: string;
  category: string;
  subcategory: string | null;
  origin: string;
  grade: string | null;
  base_price: number;
  unit: string;
  stock_quantity: number;
  is_secret_deal: boolean;
  is_active: boolean;
  description: string | null;
}

export const DEFAULT_DELIVERY_ITEMS: DefaultDeliveryItem[] = [
  {
    name: "한우 1++ 등심",
    category: "소",
    subcategory: "등심",
    origin: "국내산",
    grade: "1++ (No.9)",
    base_price: 85000,
    unit: "kg",
    stock_quantity: 10,
    is_secret_deal: false,
    is_active: true,
    description: "냉장 숙성 등심, 진공포장 출고",
  },
  {
    name: "한우 1등급 양지/사태",
    category: "소",
    subcategory: "양지",
    origin: "국내산",
    grade: "1등급",
    base_price: 29000,
    unit: "kg",
    stock_quantity: 20,
    is_secret_deal: false,
    is_active: true,
    description: "국거리 및 육수용",
  },
  {
    name: "국내산 암퇘지 삼겹살",
    category: "돼지",
    subcategory: "삼겹살",
    origin: "국내산",
    grade: "1등급",
    base_price: 18500,
    unit: "kg",
    stock_quantity: 40,
    is_secret_deal: false,
    is_active: true,
    description: "탕박 A급 규격돈, 미추리 선별",
  },
  {
    name: "국내산 목살",
    category: "돼지",
    subcategory: "목살",
    origin: "국내산",
    grade: "1등급",
    base_price: 16500,
    unit: "kg",
    stock_quantity: 40,
    is_secret_deal: false,
    is_active: true,
    description: "구이용 두께 지정 가능",
  },
  {
    name: "닭 정육 (다리살)",
    category: "닭/오리",
    subcategory: "다리살",
    origin: "국내산",
    grade: null,
    base_price: 7900,
    unit: "kg",
    stock_quantity: 30,
    is_secret_deal: false,
    is_active: true,
    description: "냉장 순살, 2kg 단위 포장",
  },
  {
    name: "생닭 10호",
    category: "닭/오리",
    subcategory: "통닭",
    origin: "국내산",
    grade: null,
    base_price: 4200,
    unit: "마리",
    stock_quantity: 50,
    is_secret_deal: false,
    is_active: true,
    description: "당일 도계 냉장",
  },
  {
    name: "수제 양념 소불고기",
    category: "가공육",
    subcategory: null,
    origin: "국내산",
    grade: null,
    base_price: 21000,
    unit: "kg",
    stock_quantity: 15,
    is_secret_deal: false,
    is_active: true,
    description: "자체 양념 배합, 냉장 2일 이내 사용 권장",
  },
  {
    name: "대패 삼겹살",
    category: "가공육",
    subcategory: null,
    origin: "국내산",
    grade: null,
    base_price: 13500,
    unit: "박스",
    stock_quantity: 12,
    is_secret_deal: false,
    is_active: true,
    description: "1박스 5kg, 냉동 슬라이스",
  },
];
