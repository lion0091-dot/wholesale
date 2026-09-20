"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { DEFAULT_DELIVERY_ITEMS } from "@/lib/products/default-delivery-items";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/products";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 상품 관리 권한 — PRD 기준 manager 이상 (staff는 발주 처리만) */
const PRODUCT_ROLES: OrgRole[] = ["owner", "manager"];

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/**
 * 상품은 레거시 wholesalers.id로 스코프된다.
 * 조직에 연결된 wholesaler_id를 우선 사용하고, 없으면 본인 profile로 조회한다.
 */
async function resolveProductScope() {
  const context = await requireOrgRole(PRODUCT_ROLES);
  const supabase = await createClient();

  let wholesalerId: string | null = null;

  if (context.organizationId) {
    const { data: organization } = await supabase
      .from("organizations")
      .select("wholesaler_id")
      .eq("id", context.organizationId)
      .maybeSingle();

    wholesalerId = (organization?.wholesaler_id as string | null) ?? null;
  }

  if (!wholesalerId) {
    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("id")
      .eq("profile_id", context.userId)
      .maybeSingle();

    wholesalerId = (wholesaler?.id as string | null) ?? null;
  }

  if (!wholesalerId) {
    throw new RbacError("공급사 업체 정보가 없어 상품을 관리할 수 없습니다.");
  }

  return { supabase, context, wholesalerId };
}

interface ProductInput {
  name: string;
  category: string;
  subcategory: string | null;
  origin: string;
  grade: string | null;
  base_price: number;
  unit: string;
  stock_quantity: number;
  is_active: boolean;
  description: string | null;
}

/** 폼 입력 검증. 원매가(purchase_price)는 DB 컬럼이 없어 저장하지 않는다(마진 계산 참고용). */
function parseProductForm(formData: FormData): ProductInput {
  const name = ((formData.get("name") as string) || "").trim();
  const category = ((formData.get("category") as string) || "").trim();
  const subcategory = ((formData.get("subcategory") as string) || "").trim() || null;
  const origin = ((formData.get("origin") as string) || "").trim();
  const grade = ((formData.get("grade") as string) || "").trim() || null;
  const unit = ((formData.get("unit") as string) || "kg").trim();
  // 화면에서 천 단위 콤마를 붙여 표시하므로("25,000") 서버에서 항상 콤마를 제거하고 파싱한다.
  const basePrice = Number.parseFloat(((formData.get("base_price") as string) || "").replace(/,/g, ""));
  const stockQuantity = Number.parseFloat((formData.get("stock_quantity") as string) || "0");
  const description = ((formData.get("description") as string) || "").trim() || null;

  if (name.length < 2) {
    throw new RbacError("상품명을 2자 이상 입력해주세요.");
  }

  if (!category) {
    throw new RbacError("카테고리(부위 구분)를 선택해주세요.");
  }

  if (!origin) {
    throw new RbacError("원산지를 입력해주세요.");
  }

  if (!Number.isFinite(basePrice) || basePrice < 0) {
    throw new RbacError("기본 단가는 0 이상의 숫자여야 합니다.");
  }

  if (!Number.isFinite(stockQuantity) || stockQuantity < 0) {
    throw new RbacError("재고 수량은 0 이상의 숫자여야 합니다.");
  }

  return {
    name,
    category,
    subcategory,
    origin,
    grade,
    base_price: basePrice,
    unit,
    stock_quantity: stockQuantity,
    is_active: formData.get("is_active") !== "off",
    description,
  };
}

// ====================================================================
// 1. 상품 등록
// ====================================================================
export async function createProductAction(
  formData: FormData
): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase, wholesalerId } = await resolveProductScope();
    const input = parseProductForm(formData);

    const { data, error } = await supabase
      .from("products")
      .insert({ wholesaler_id: wholesalerId, ...input })
      .select("id")
      .single();

    if (error || !data) {
      throw new Error(error?.message ?? "상품 등록에 실패했습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: data.id as string } };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 2. 상품 수정
// ====================================================================
export async function updateProductAction(
  productId: string,
  formData: FormData
): Promise<ActionResult> {
  try {
    const { supabase, context, wholesalerId } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    const input = parseProductForm(formData);
    const expectedUpdatedAt = ((formData.get("updated_at") as string) || "").trim();

    // 축종/상품명/원산지는 상품 마스터의 정체성 키다 — 이 셋이 같으면 같은 상품으로
    // 취급하므로 등록 후에는 셋 다 변경을 막는다(폼에서도 읽기전용). 셋 중 하나라도
    // 다르면 수정이 아니라 신규 상품 등록으로 유도한다. 단위·기본단가·재고 등
    // 나머지 마스터 값만 여기서 갱신한다.
    // 소유권 확인용 SELECT를 따로 두지 않고, 이 UPDATE 자체에 조직 필터(super_admin은 예외)와
    // updated_at 일치 조건을 함께 걸어 1회 왕복으로 권한 확인·동시편집 충돌 감지·반영을 처리한다.
    let query = supabase
      .from("products")
      .update({
        subcategory: input.subcategory,
        grade: input.grade,
        base_price: input.base_price,
        unit: input.unit,
        stock_quantity: input.stock_quantity,
        is_active: input.is_active,
        description: input.description,
        updated_at: new Date().toISOString(),
      })
      .eq("id", productId);

    if (!context.isSuperAdmin) {
      query = query.eq("wholesaler_id", wholesalerId);
    }

    // 폼을 열어둔 사이 목록의 빠른 토글 등으로 다른 곳에서 먼저 저장됐다면 그 변경을
    // 이 폼의(로드 시점 기준) 값으로 덮어쓰지 않고 충돌로 처리한다.
    if (expectedUpdatedAt) {
      query = query.eq("updated_at", expectedUpdatedAt);
    }

    const { data, error } = await query.select("id").maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    // 0건 반영은 상품이 없거나(잘못된 id), 다른 공급사 소유거나, 그 사이 다른 곳에서
    // 먼저 저장돼 updated_at이 어긋난 경우 전부에 해당할 수 있다 — 구분하지 않고 안내한다.
    if (!data) {
      throw new RbacError(
        "상품을 찾을 수 없거나 다른 곳에서 먼저 변경되었습니다. 새로고침 후 다시 시도해주세요."
      );
    }

    revalidatePath(REVALIDATE_PATH);
    revalidatePath(`/dashboard/products/${productId}/edit`);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 3. 판매 상태 토글
// ====================================================================
export async function toggleProductFlagAction(
  productId: string,
  field: "is_active",
  nextValue: boolean
): Promise<ActionResult> {
  try {
    const { supabase, context, wholesalerId } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    if (field !== "is_active") {
      throw new RbacError("변경할 수 없는 항목입니다.");
    }

    let query = supabase
      .from("products")
      .update({ [field]: nextValue, updated_at: new Date().toISOString() })
      .eq("id", productId);

    if (!context.isSuperAdmin) {
      query = query.eq("wholesaler_id", wholesalerId);
    }

    const { data, error } = await query.select("id").maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      throw new RbacError("변경 권한이 없어 저장되지 않았습니다. 새로고침 후 다시 시도해주세요.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 4. 재고 수량 변경
// ====================================================================
export async function updateProductStockAction(
  productId: string,
  nextStock: number
): Promise<ActionResult> {
  try {
    const { supabase, context, wholesalerId } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    if (!Number.isFinite(nextStock) || nextStock < 0) {
      throw new RbacError("재고 수량은 0 이상의 숫자여야 합니다.");
    }

    let query = supabase
      .from("products")
      .update({ stock_quantity: nextStock, updated_at: new Date().toISOString() })
      .eq("id", productId);

    if (!context.isSuperAdmin) {
      query = query.eq("wholesaler_id", wholesalerId);
    }

    const { data, error } = await query.select("id").maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      throw new RbacError("변경 권한이 없어 저장되지 않았습니다. 새로고침 후 다시 시도해주세요.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 5. 상품 삭제
// ====================================================================
export async function deleteProductAction(productId: string): Promise<ActionResult> {
  try {
    const { supabase, context, wholesalerId } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    let query = supabase.from("products").delete().eq("id", productId);

    if (!context.isSuperAdmin) {
      query = query.eq("wholesaler_id", wholesalerId);
    }

    const { data, error } = await query.select("id").maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    // 소유권 확인용 SELECT를 따로 하지 않으므로, 0건 반영(다른 공급사 소유 등)도
    // 여기서 걸러야 한다 — 그렇지 않으면 조용히 아무 것도 지우지 않고 "성공"을 반환한다.
    if (!data) {
      throw new RbacError("삭제 권한이 없거나 해당 상품을 찾을 수 없습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 6. 기본 납품 품목 일괄 생성 (온보딩)
// ====================================================================
/**
 * 상품이 한 건도 없는 공급사에 기본 납품 품목 세트를 생성한다.
 * 이미 상품이 있으면 중복 생성을 막기 위해 거부한다.
 * 성공 시 미니샵(/shop/<shop_token>)도 함께 무효화하여 데모 카탈로그를 벗어나게 한다.
 */
export async function seedDefaultProductsAction(): Promise<ActionResult<{ created: number }>> {
  try {
    const { supabase, wholesalerId } = await resolveProductScope();

    const { count, error: countError } = await supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("wholesaler_id", wholesalerId);

    if (countError) {
      throw new Error(countError.message);
    }

    if ((count ?? 0) > 0) {
      throw new RbacError(
        "이미 등록된 상품이 있습니다. 기본 납품 품목은 상품이 없을 때만 불러올 수 있습니다."
      );
    }

    const { data, error } = await supabase
      .from("products")
      .insert(
        DEFAULT_DELIVERY_ITEMS.map((item) => ({ wholesaler_id: wholesalerId, ...item }))
      )
      .select("id");

    if (error) {
      throw new Error(error.message);
    }

    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("shop_token")
      .eq("id", wholesalerId)
      .maybeSingle();

    revalidatePath(REVALIDATE_PATH);
    revalidatePath("/dashboard");

    if (wholesaler?.shop_token) {
      revalidatePath(`/shop/${wholesaler.shop_token}`);
    }

    return { success: true, data: { created: data?.length ?? 0 } };
  } catch (error) {
    return toResult(error);
  }
}
