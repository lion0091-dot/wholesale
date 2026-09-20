import type { createClient } from "@/lib/supabase/server";
import { RbacError } from "@/lib/auth/rbac";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AssertOwnedProductOptions {
  /** true면 소유권 검증을 건너뛴다 (기본 false) */
  isSuperAdmin?: boolean;
  notFoundMessage?: string;
  forbiddenMessage?: string;
}

/** 상품이 지정된 wholesalerId 소유인지 확인한다. wholesalerId가 null이면 소유권 검증은 건너뛴다. */
export async function assertOwnedProduct(
  supabase: Awaited<ReturnType<typeof createClient>>,
  productId: string,
  wholesalerId: string | null,
  options: AssertOwnedProductOptions = {}
): Promise<void> {
  const {
    isSuperAdmin = false,
    notFoundMessage = "해당 상품을 찾을 수 없습니다.",
    forbiddenMessage = "다른 공급사의 상품에는 접근할 수 없습니다.",
  } = options;

  if (!UUID_PATTERN.test(productId)) {
    throw new RbacError("올바른 상품 식별자가 아닙니다.");
  }

  const { data: product } = await supabase
    .from("products")
    .select("id, wholesaler_id")
    .eq("id", productId)
    .maybeSingle();

  if (!product) {
    throw new RbacError(notFoundMessage);
  }

  if (!isSuperAdmin && wholesalerId && product.wholesaler_id !== wholesalerId) {
    throw new RbacError(forbiddenMessage);
  }
}
