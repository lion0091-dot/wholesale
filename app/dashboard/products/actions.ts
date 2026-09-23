"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { DEFAULT_DELIVERY_ITEMS } from "@/lib/products/default-delivery-items";
import { STOCK_ADJUST_REASON_CODES } from "@/lib/products/stock-adjust-reasons";

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
        // stock_quantity는 여기서 갱신하지 않는다 — 재고는 stock_ledger 합계로
        // 파생되므로 여기서 덮어쓰면 다음 입고/출고 때 recalc_product_stock()에
        // 의해 조용히 되돌아간다. 수정은 목록의 "재고 조정"(사유 기록)으로만 한다.
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
// 4. 재고 조정 (예전 "재고 수량 변경")
//
// stock_quantity를 직접 UPDATE하면 안 된다 — 재고는 이제 stock_ledger 합계로
// 파생되므로, 덮어쓴 값이 다음 입고/출고 때 recalc_product_stock()에 의해
// 조용히 되돌아간다. 대신 adjust_product_stock() RPC가 차이분을 원장 행으로
// 남기고, 왜 바뀌었는지(실사/폐기/파손/반품)를 함께 기록한다.
// ====================================================================


export async function updateProductStockAction(
  productId: string,
  nextStock: number,
  reasonCode: string,
  reasonNote?: string
): Promise<ActionResult> {
  try {
    const { supabase } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    if (!Number.isFinite(nextStock) || nextStock < 0) {
      throw new RbacError("재고 수량은 0 이상의 숫자여야 합니다.");
    }

    if (!STOCK_ADJUST_REASON_CODES.includes(reasonCode)) {
      throw new RbacError("조정 사유를 선택해주세요.");
    }

    const { error } = await supabase.rpc("adjust_product_stock", {
      p_product_id: productId,
      p_new_quantity: nextStock,
      p_reason_code: reasonCode,
      p_reason_note: reasonNote?.trim() || null,
    });

    if (error) {
      if (error.message.includes("PRODUCT_NOT_FOUND")) {
        throw new RbacError("변경 권한이 없어 저장되지 않았습니다. 새로고침 후 다시 시도해주세요.");
      }

      throw new Error(error.message);
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

    // 입출고 기록이 있으면 삭제가 아예 불가능하다 — stock_ledger.product_id가
    // ON DELETE RESTRICT다(입출고 기록은 지우면 안 되는 자료). DB가 막기 전에
    // 먼저 확인해 "보관하세요"라고 안내한다. 그냥 두면 외래키 위반 메시지가
    // 그대로 노출된다.
    const { data: hasHistory } = await supabase.rpc("product_has_stock_history", {
      p_product_id: productId,
    });

    if (hasHistory) {
      throw new RbacError(
        "입출고 기록이 있는 상품은 삭제할 수 없습니다. 기록을 남겨야 하기 때문입니다 — 대신 '보관'으로 목록에서 감출 수 있습니다."
      );
    }

    let query = supabase.from("products").delete().eq("id", productId);

    if (!context.isSuperAdmin) {
      query = query.eq("wholesaler_id", wholesalerId);
    }

    const { data, error } = await query.select("id").maybeSingle();

    if (error) {
      // 23503 = foreign_key_violation. product_has_stock_history()는 stock_ledger만
      // 보므로, 재고 기록은 없지만 주문(order_items, ON DELETE RESTRICT)에 걸린
      // 상품은 위 체크를 통과해 여기서 걸린다 — 어느 테이블이 막았든 사용자에게는
      // 같은 안내(보관 유도)가 맞다.
      if (error.code === "23503") {
        throw new RbacError(
          "이 상품을 참조하는 기록이 있어 삭제할 수 없습니다. 기록을 남겨야 하기 때문입니다 — 대신 '보관'으로 목록에서 감출 수 있습니다."
        );
      }

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
// 6. 상품 보관 / 복원
//
// 입출고 기록이 있는 상품은 지울 수 없으므로(위 참고) 목록에서 치우는 수단이
// 따로 필요하다. 보관하면 상품 목록과 고객 카탈로그 양쪽에서 빠지고, 기록은
// 그대로 남는다. 보관 시 판매도 함께 내린다 — 목록에서 감췄는데 미니샵에
// 남아 있으면 사고다.
// ====================================================================
export async function setProductArchivedAction(
  productId: string,
  archived: boolean
): Promise<ActionResult> {
  try {
    const { supabase } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    const { error } = await supabase.rpc("set_product_archived", {
      p_product_id: productId,
      p_archived: archived,
    });

    if (error) {
      if (error.message.includes("PRODUCT_NOT_FOUND")) {
        throw new RbacError("권한이 없거나 해당 상품을 찾을 수 없습니다.");
      }

      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 7. 기본 납품 품목 일괄 등록
// ====================================================================
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

// ====================================================================
// 8. 판매가 일괄 등록
//
// 스캔으로 자동 등록된 상품은 판매가가 0원이라 고객에게 안 보인다. 수십 개를
// 화면에서 하나씩 고치는 건 고통스러워서, 목록을 CSV로 내려받아 엑셀에서 값을
// 채우고 다시 올리는 경로를 둔다. 상품 식별은 UUID로만 한다 — 이름으로 맞추면
// 엑셀에서 이름을 고친 순간 엉뚱한 상품 가격이 바뀐다.
// ====================================================================
export interface BulkPriceResult {
  updated: number;
  /** 값을 안 채운 줄 */
  skipped: number;
  /** ID가 없거나 내 상품이 아니거나 보관된 줄 */
  notFound: number;
}

export async function bulkUpdateProductPricesAction(
  updates: Array<{ id: string; price: number }>,
  activate: boolean
): Promise<ActionResult<BulkPriceResult>> {
  try {
    const { supabase } = await resolveProductScope();

    if (updates.length === 0) {
      throw new RbacError("반영할 판매가가 없습니다.");
    }

    if (updates.length > 5_000) {
      throw new RbacError("한 번에 5,000행까지만 올릴 수 있습니다.");
    }

    const { data, error } = await supabase.rpc("bulk_update_product_prices", {
      p_updates: updates.map((row) => ({ id: row.id, price: String(row.price) })),
      p_activate: activate,
    });

    if (error) {
      throw new Error(error.message);
    }

    const row = (data ?? {}) as Record<string, unknown>;

    revalidatePath(REVALIDATE_PATH);

    return {
      success: true,
      data: {
        updated: Number(row.updated ?? 0),
        skipped: Number(row.skipped ?? 0),
        notFound: Number(row.not_found ?? 0),
      },
    };
  } catch (error) {
    return toResult(error);
  }
}
