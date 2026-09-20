"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole } from "@/lib/auth/rbac";
import { assertOwnedProduct } from "@/lib/products/ownership";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

export type CustomPriceKind = "custom" | "hot_deal";

export interface CustomPriceRow {
  id: string;
  organization_id: string | null;
  wholesaler_id: string | null;
  retailer_id: string;
  product_id: string;
  custom_price: number;
  kind: CustomPriceKind;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const REVALIDATE_PATH = "/dashboard/custom-prices";
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

function assertKind(kind: string): asserts kind is CustomPriceKind {
  if (kind !== "custom" && kind !== "hot_deal") {
    throw new RbacError("올바르지 않은 단가 종류입니다.");
  }
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
// 1. 고객사별 맞춤 단가/핫딜 설정 (신규/변경 = upsert, 종류별로 독립된 행)
// ====================================================================
export async function setCustomPrice(formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase, organizationId, wholesalerId } = await resolveOwnerScope([
      "owner",
      "manager",
    ]);

    // wholesalerId가 비어있으면 assertOwnedProduct의 소유권 검증과 아래 거래관계
    // 확인이 둘 다 건너뛰어져(assertOwnedProduct/if(wholesalerId) 모두 falsy 스킵),
    // 남의 상품에 남의 거래처를 대상으로 단가를 심을 수 있었다 —
    // setCustomPriceForAllAction과 동일하게 여기서 먼저 막는다.
    if (!wholesalerId) {
      throw new RbacError("공급사 정보를 확인할 수 없습니다.");
    }

    const retailerId = ((formData.get("retailer_id") as string) || "").trim();
    const productId = ((formData.get("product_id") as string) || "").trim();
    const kind = ((formData.get("kind") as string) || "custom").trim();
    const customPrice = Number.parseFloat((formData.get("custom_price") as string) || "");

    assertKind(kind);

    if (!UUID_PATTERN.test(retailerId) || !UUID_PATTERN.test(productId)) {
      throw new RbacError("고객사와 상품을 올바르게 선택해주세요.");
    }

    if (!Number.isFinite(customPrice) || customPrice < 0) {
      throw new RbacError("단가는 0 이상의 숫자여야 합니다.");
    }

    await assertOwnedProduct(supabase, productId, wholesalerId, {
      forbiddenMessage: "다른 공급사의 상품에는 단가를 설정할 수 없습니다.",
    });

    // 거래 관계가 있는 고객사인지 확인
    const { data: relation } = await supabase
      .from("wholesaler_retailers")
      .select("id, status")
      .eq("wholesaler_id", wholesalerId)
      .eq("retailer_id", retailerId)
      .maybeSingle();

    if (!relation || relation.status !== "active") {
      throw new RbacError("거래 중인 고객사가 아닙니다.");
    }

    const { data, error } = await supabase
      .from("custom_prices")
      .upsert(
        {
          organization_id: organizationId,
          wholesaler_id: wholesalerId,
          retailer_id: retailerId,
          product_id: productId,
          kind,
          custom_price: customPrice,
          // 꺼져 있던 행을 이 폼으로 다시 저장하면 가격만 바뀌고 꺼진 채로 남는 문제 방지 —
          // 노출 on/off는 별도 토글로 다루고, 이 폼의 저장은 항상 "켜서 반영"을 의미한다.
          is_active: true,
        },
        { onConflict: "retailer_id,product_id,kind" }
      )
      .select("id")
      .single();

    if (error || !data) {
      throw new Error(error?.message ?? "단가 저장에 실패했습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: data.id as string } };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 2. 거래중인 고객 전원에게 일괄 생성 — 이미 지정된 고객은 건드리지 않고
//    아직 없는 고객만 새로 채워넣는다(가격 재설정 용도가 아님).
// ====================================================================
export async function setCustomPriceForAllAction(
  productId: string,
  kind: CustomPriceKind,
  customPrice: number
): Promise<ActionResult<{ created: number; skipped: number }>> {
  try {
    const { supabase, organizationId, wholesalerId } = await resolveOwnerScope([
      "owner",
      "manager",
    ]);

    assertKind(kind);

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("상품을 올바르게 선택해주세요.");
    }

    if (!Number.isFinite(customPrice) || customPrice < 0) {
      throw new RbacError("단가는 0 이상의 숫자여야 합니다.");
    }

    if (!wholesalerId) {
      throw new RbacError("공급사 정보를 확인할 수 없습니다.");
    }

    await assertOwnedProduct(supabase, productId, wholesalerId, {
      forbiddenMessage: "다른 공급사의 상품에는 단가를 설정할 수 없습니다.",
    });

    const [{ data: relations }, { data: existing }] = await Promise.all([
      supabase
        .from("wholesaler_retailers")
        .select("retailer_id")
        .eq("wholesaler_id", wholesalerId)
        .eq("status", "active"),
      supabase
        .from("custom_prices")
        .select("retailer_id, is_active")
        .eq("product_id", productId)
        .eq("kind", kind),
    ]);

    // 이미 켜져 있는 고객만 "건드리지 않음"으로 간주한다. 꺼져 있는 고객은 옛 가격이
    // 남아있으므로 새로 켤 때 이번 가격으로 재활성화해야 한다.
    const existingActiveRetailerIds = new Set(
      (existing ?? []).filter((row) => row.is_active).map((row) => row.retailer_id as string)
    );
    const targetRetailerIds = ((relations ?? []) as Array<{ retailer_id: string }>)
      .map((row) => row.retailer_id)
      .filter((id) => !existingActiveRetailerIds.has(id));

    if (targetRetailerIds.length === 0) {
      return { success: true, data: { created: 0, skipped: existingActiveRetailerIds.size } };
    }

    const { error } = await supabase.from("custom_prices").upsert(
      targetRetailerIds.map((retailerId) => ({
        organization_id: organizationId,
        wholesaler_id: wholesalerId,
        retailer_id: retailerId,
        product_id: productId,
        kind,
        custom_price: customPrice,
        is_active: true,
      })),
      { onConflict: "retailer_id,product_id,kind" }
    );

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return {
      success: true,
      data: { created: targetRetailerIds.length, skipped: existingActiveRetailerIds.size },
    };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 3. 맞춤 단가/핫딜 조회 (조직 전체 또는 특정 고객사, 종류별)
// ====================================================================
export async function listCustomPrices(
  kind?: CustomPriceKind,
  retailerId?: string
): Promise<ActionResult<CustomPriceRow[]>> {
  try {
    const { supabase, organizationId } = await resolveOwnerScope(["owner", "manager", "staff"]);

    let query = supabase
      .from("custom_prices")
      .select(
        "id, organization_id, wholesaler_id, retailer_id, product_id, custom_price, kind, is_active, created_at, updated_at"
      )
      .eq("organization_id", organizationId)
      .order("updated_at", { ascending: false });

    if (kind) {
      assertKind(kind);
      query = query.eq("kind", kind);
    }

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
// 4. 노출 on/off (가격 데이터는 보존한 채 그 고객에게는 기본 상품 정가로 되돌림)
// ====================================================================
export async function toggleCustomPriceActiveAction(
  id: string,
  isActive: boolean
): Promise<ActionResult> {
  try {
    const { supabase, context, organizationId } = await resolveOwnerScope(["owner", "manager"]);

    if (!UUID_PATTERN.test(id)) {
      throw new RbacError("올바른 단가 식별자가 아닙니다.");
    }

    // bulkToggleCustomPriceActiveAction과 동일하게 조직 범위 필터를 UPDATE에 직접
    // 걸어 1회 왕복으로 권한 확인과 반영을 함께 처리한다(super_admin은 조직 무관 허용).
    let query = supabase.from("custom_prices").update({ is_active: isActive }).eq("id", id);

    if (!context.isSuperAdmin) {
      query = query.eq("organization_id", organizationId);
    }

    const { data, error } = await query.select("id").maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      throw new RbacError("해당 단가를 찾을 수 없거나 변경할 수 없습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 5. 상품 단위 일괄 on/off (그 상품의 그 종류 매핑 전체를 한 번에 전환)
// ====================================================================
export async function bulkToggleCustomPriceActiveAction(
  productId: string,
  kind: CustomPriceKind,
  isActive: boolean
): Promise<ActionResult<{ updated: number }>> {
  try {
    const { supabase, organizationId } = await resolveOwnerScope(["owner", "manager"]);

    // Server Action은 HTTP 엔드포인트로도 직접 호출 가능하므로 TS 타입만으로는
    // 부족하다 — 컴파일 타입 보호와 별개로 런타임 검증을 유지한다.
    assertKind(kind);

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("상품을 올바르게 선택해주세요.");
    }

    const { data, error } = await supabase
      .from("custom_prices")
      .update({ is_active: isActive })
      .eq("organization_id", organizationId)
      .eq("product_id", productId)
      .eq("kind", kind)
      .select("id");

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { updated: data?.length ?? 0 } };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 6. 맞춤 단가/핫딜 삭제
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
