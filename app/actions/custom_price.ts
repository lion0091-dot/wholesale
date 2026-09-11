"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole } from "@/lib/auth/rbac";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface CustomPriceRow {
  id: string;
  organization_id: string | null;
  wholesaler_id: string | null;
  retailer_id: string;
  product_id: string;
  custom_price: number;
  created_at: string;
  updated_at: string;
}

const REVALIDATE_PATH = "/wholesaler/custom-prices";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/** 현재 조직 컨텍스트 + 연결된 레거시 wholesaler_id 확보 */
async function resolveOwnerScope(allowed: Array<"owner" | "manager" | "staff">) {
  const context = await requireOrgRole(allowed);
  const supabase = await createClient();

  if (!context.organizationId) {
    throw new RbacError("소속된 공급사 조직이 없습니다.");
  }

  const { data: organization } = await supabase
    .from("organizations")
    .select("id, wholesaler_id")
    .eq("id", context.organizationId)
    .maybeSingle();

  return {
    supabase,
    context,
    organizationId: context.organizationId,
    wholesalerId: (organization?.wholesaler_id as string | null) ?? null,
  };
}

// ====================================================================
// 1. 고객사별 맞춤 단가 설정 (신규/변경 = upsert)
// ====================================================================
export async function setCustomPrice(
  formData: FormData
): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase, organizationId, wholesalerId } = await resolveOwnerScope([
      "owner",
      "manager",
    ]);

    const retailerId = ((formData.get("retailer_id") as string) || "").trim();
    const productId = ((formData.get("product_id") as string) || "").trim();
    const customPrice = Number.parseFloat((formData.get("custom_price") as string) || "");

    if (!UUID_PATTERN.test(retailerId) || !UUID_PATTERN.test(productId)) {
      throw new RbacError("고객사와 상품을 올바르게 선택해주세요.");
    }

    if (!Number.isFinite(customPrice) || customPrice < 0) {
      throw new RbacError("맞춤 단가는 0 이상의 숫자여야 합니다.");
    }

    // 상품이 본인 공급사 소유인지 확인 (RLS로 이중 차단되지만 명시적으로 검증)
    const { data: product } = await supabase
      .from("products")
      .select("id, wholesaler_id")
      .eq("id", productId)
      .maybeSingle();

    if (!product) {
      throw new RbacError("해당 상품을 찾을 수 없습니다.");
    }

    if (wholesalerId && product.wholesaler_id !== wholesalerId) {
      throw new RbacError("다른 공급사의 상품에는 단가를 설정할 수 없습니다.");
    }

    // 거래 관계가 있는 고객사인지 확인
    if (wholesalerId) {
      const { data: relation } = await supabase
        .from("wholesaler_retailers")
        .select("id, status")
        .eq("wholesaler_id", wholesalerId)
        .eq("retailer_id", retailerId)
        .maybeSingle();

      if (!relation || relation.status !== "active") {
        throw new RbacError("거래 중인 고객사가 아닙니다.");
      }
    }

    const { data, error } = await supabase
      .from("custom_prices")
      .upsert(
        {
          organization_id: organizationId,
          wholesaler_id: wholesalerId,
          retailer_id: retailerId,
          product_id: productId,
          custom_price: customPrice,
        },
        { onConflict: "retailer_id,product_id" }
      )
      .select("id")
      .single();

    if (error || !data) {
      throw new Error(error?.message ?? "맞춤 단가 저장에 실패했습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: data.id as string } };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 2. 맞춤 단가 조회 (조직 전체 또는 특정 고객사)
// ====================================================================
export async function listCustomPrices(
  retailerId?: string
): Promise<ActionResult<CustomPriceRow[]>> {
  try {
    const { supabase, organizationId } = await resolveOwnerScope(["owner", "manager", "staff"]);

    let query = supabase
      .from("custom_prices")
      .select(
        "id, organization_id, wholesaler_id, retailer_id, product_id, custom_price, created_at, updated_at"
      )
      .eq("organization_id", organizationId)
      .order("updated_at", { ascending: false });

    if (retailerId) {
      if (!UUID_PATTERN.test(retailerId)) {
        throw new RbacError("올바른 고객사 식별자가 아닙니다.");
      }
      query = query.eq("retailer_id", retailerId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    return { success: true, data: (data ?? []) as CustomPriceRow[] };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 3. 특정 고객사/상품의 적용 단가 조회 (맞춤 단가 없으면 기준가)
// ====================================================================
export async function getEffectivePrice(
  retailerId: string,
  productId: string
): Promise<ActionResult<{ price: number; isCustom: boolean }>> {
  try {
    const { supabase, organizationId } = await resolveOwnerScope(["owner", "manager", "staff"]);

    if (!UUID_PATTERN.test(retailerId) || !UUID_PATTERN.test(productId)) {
      throw new RbacError("고객사와 상품을 올바르게 선택해주세요.");
    }

    const { data: custom } = await supabase
      .from("custom_prices")
      .select("custom_price")
      .eq("organization_id", organizationId)
      .eq("retailer_id", retailerId)
      .eq("product_id", productId)
      .maybeSingle();

    if (custom) {
      return { success: true, data: { price: Number(custom.custom_price), isCustom: true } };
    }

    const { data: product, error } = await supabase
      .from("products")
      .select("base_price")
      .eq("id", productId)
      .maybeSingle();

    if (error || !product) {
      throw new RbacError("해당 상품을 찾을 수 없습니다.");
    }

    return { success: true, data: { price: Number(product.base_price), isCustom: false } };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 4. 맞춤 단가 삭제 (기준가로 복귀)
// ====================================================================
export async function deleteCustomPrice(id: string): Promise<ActionResult> {
  try {
    const { supabase, organizationId, context } = await resolveOwnerScope(["owner", "manager"]);

    if (!UUID_PATTERN.test(id)) {
      throw new RbacError("올바른 단가 식별자가 아닙니다.");
    }

    const { data: target } = await supabase
      .from("custom_prices")
      .select("id, organization_id")
      .eq("id", id)
      .maybeSingle();

    if (!target) {
      throw new RbacError("해당 맞춤 단가를 찾을 수 없습니다.");
    }

    if (!context.isSuperAdmin && target.organization_id !== organizationId) {
      throw new RbacError("다른 조직의 단가는 삭제할 수 없습니다.");
    }

    const { error } = await supabase.from("custom_prices").delete().eq("id", id);

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}
