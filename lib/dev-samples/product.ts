/**
 * 개발용 미리보기 — 상품관리 화면의 "샘플 보기" 패널 데이터.
 *
 * 입고 화면(4가지 이력번호 유형)이 확정되면 여기 상품 목록에 실제로 어떻게
 * 나타나는지 실제 API·DB 없이 보여준다. 공급자 자체 코드(③④)는 정부 API에
 * 한 번도 안 걸렸으므로 도축일·등급 정보가 끝까지 비어 있다 — 그게 실제로
 * 다른 점이라 샘플에도 그대로 반영했다(livestock-inbound-tracking.md 1단계
 * 설계 결정: 이력번호가 아니라 박스가 재고 단위).
 *
 * 오픈 전에는 지워야 하는 개발 도구다 — 폐기할 때는 이 파일 전체
 * (`lib/dev-samples/` 폴더)를 지우고, `app/dashboard/products/product-table.tsx`
 * 에서 이 모듈을 가져다 쓰는 부분(패널 렌더링 + addSampleProduct/
 * removeSampleProduct/clearSampleProducts, SampleProduct 캐스팅)만 지우면 된다.
 */
import type { Product } from "@/types/database";
import type { StockSummary } from "@/app/dashboard/products/product-table";

/** 개발용 미리보기 상품 — DB에 없다. 화면에만 얹고 실제 동작은 막는다. */
export type SampleProduct = Product & { isSample: true; sampleNote: string };

interface ProductSampleKind {
  label: string;
  name: string;
  grade: string | null;
  stock: number;
  summary: Pick<StockSummary, "box_count" | "oldest_slaughter_date" | "oldest_packing_date" | "grades">;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

export const PRODUCT_SAMPLE_KINDS = {
  NORMAL_INDIVIDUAL: {
    label: "① 일반 개체 (API 확인됨)",
    name: "한우 등심 1++",
    grade: "1++",
    stock: 8.2,
    summary: { box_count: 1, oldest_slaughter_date: daysAgo(3), oldest_packing_date: daysAgo(1), grades: "1++" },
  },
  NORMAL_GROUP: {
    label: "② 정부 발행 묶음 (API 확인됨)",
    name: "한우 갈비 1+",
    grade: "1+",
    stock: 15.0,
    summary: { box_count: 2, oldest_slaughter_date: daysAgo(5), oldest_packing_date: daysAgo(2), grades: "1+" },
  },
  SUPPLIER_BUNDLE: {
    label: "③ 공급자 자체 묶음 (API에 없음)",
    name: "수입 삼겹살 (공급자 코드)",
    grade: null,
    stock: 5.0,
    // 정부 API에 한 번도 안 걸려서 도축일·등급이 끝까지 비어 있다.
    summary: { box_count: 1, oldest_slaughter_date: null, oldest_packing_date: null, grades: null },
  },
  ORDER_BUNDLE: {
    label: "④ 고객주문용 묶음 (거의 다 배정됨)",
    name: "특수 부위 (고객 주문 전용)",
    grade: null,
    // 들어오자마자 "주문에 바로 배정"으로 대부분 나가서 남는 재고가 적다.
    stock: 0.3,
    summary: { box_count: 1, oldest_slaughter_date: null, oldest_packing_date: null, grades: null },
  },
} satisfies Record<string, ProductSampleKind>;

export type ProductSampleKey = keyof typeof PRODUCT_SAMPLE_KINDS;

/** 선택한 유형 하나를 실제 Product + StockSummary 모양으로 만든다. */
export function buildSampleProduct(kind: ProductSampleKey): { product: SampleProduct; stockSummary: StockSummary } {
  const sample = PRODUCT_SAMPLE_KINDS[kind];
  const id = `sample-${kind}-${Date.now()}`;
  const now = new Date().toISOString();

  const product: SampleProduct = {
    id,
    wholesaler_id: "sample",
    name: sample.name,
    category: "소",
    subcategory: null,
    origin: "국내산",
    grade: sample.grade,
    base_price: 0,
    unit: "kg",
    stock_quantity: sample.stock,
    is_active: false,
    description: null,
    created_at: now,
    updated_at: now,
    created_by: null,
    updated_by: null,
    archived_at: null,
    isSample: true,
    sampleNote: sample.label,
  };

  const stockSummary: StockSummary = {
    product_id: id,
    latest_slaughter_date: sample.summary.oldest_slaughter_date,
    ...sample.summary,
  };

  return { product, stockSummary };
}
