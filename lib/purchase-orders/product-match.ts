import { identityFieldsFor } from "@/lib/products/identity-key";
import { originMatches } from "@/lib/products/origin-options";

/** 발주서 줄에서 고를 수 있는 상품(보관되지 않은 것) — 목록 표시와 스펙 매칭에 필요한 칸만. */
export interface ProductOption {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  grade: string | null;
  breed: string | null;
  origin: string | null;
}

export interface LineSpec {
  category: string;
  breed: string;
  subcategory: string;
  grade: string;
  origin: string;
}

const clean = (value: string | null | undefined) => (value ?? "").trim();

/**
 * 목록·줄에 보이는 한 줄 이름 — 정체성 키가 있는 축종은 키 칸만("소 한우 등심 1++ 국내산", 돼지는 등급 없이, 닭·오리·계란은 "닭 국내산"),
 * 키가 없는 축종(양·가공육)은 스펙만으로 상품을 못 가르니 상품명을 넣는다.
 */
export function productSpecLabel(product: ProductOption): string {
  const fields = identityFieldsFor(product.category);

  if (!fields) {
    return [product.category, product.name, product.origin].map(clean).filter(Boolean).join(" ");
  }

  return [
    product.category,
    fields.includes("breed") ? product.breed : null,
    fields.includes("subcategory") ? product.subcategory : null,
    fields.includes("grade") ? product.grade : null,
    product.origin,
  ]
    .map(clean)
    .filter(Boolean)
    .join(" ");
}

/**
 * 상품을 발주서 줄 스펙으로 옮긴다. 키가 없는 축종은 부위 칸이 비어 있어도 줄이 무슨 물건인지 보이게 상품명을 부위 자리에 둔다
 * (줄에는 상품명 칸이 없다 — 카톡 문구·목록은 이 스펙 칸만 읽는다).
 */
export function specFromProduct(product: ProductOption): LineSpec {
  const hasKey = identityFieldsFor(product.category) !== null;

  return {
    category: product.category,
    breed: clean(product.breed),
    subcategory: clean(product.subcategory) || (hasKey ? "" : clean(product.name)),
    grade: clean(product.grade),
    origin: clean(product.origin),
  };
}

/**
 * 스펙과 같은 상품을 찾는다 — 정체성 키 칸이 모두 같아야 한다(원산지는 포함 비교). 키가 없는 축종은 스펙으로 상품을 못 정하니 null.
 * 키 칸이 비어 있는 줄("소 안심 국내산"처럼 등급이 빈 줄)은 등급이 빈 상품하고만 맞는다 — 짐작으로 붙이지 않는다.
 *
 * 성별·냉장/냉동(2026-09-30 추가)은 발주서 줄 스펙에 아직 없다 — 발주서는 품종·부위·등급·
 * 원산지까지만 고르고, 그 안에서 성별·냉장냉동이 갈리는 상품이 여럿이면 첫 번째로 찾은
 * 것을 쓴다. 입고 박스↔발주서 줄 대조(purchase-order-receiving)의 정확도를 더 올리려면
 * 이 스펙에도 성별·냉장냉동을 추가해야 하지만, 그건 발주서 화면 자체를 바꿔야 하는
 * 별도 작업이라 이번엔 손대지 않았다.
 */
export function findProductForSpec(spec: LineSpec, products: readonly ProductOption[]): ProductOption | null {
  const fields = identityFieldsFor(spec.category)?.filter(
    (field) => field !== "sex" && field !== "storageState"
  );

  if (!fields) {
    return null;
  }

  return (
    products.find(
      (product) =>
        product.category === spec.category &&
        fields.every((field) =>
          field === "origin"
            ? originMatches(product.origin, spec.origin)
            : clean(product[field as keyof ProductOption] as string | null) ===
              clean(spec[field as keyof LineSpec] as string | undefined)
        )
    ) ?? null
  );
}
