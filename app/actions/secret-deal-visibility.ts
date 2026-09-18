"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import type { ActionResult } from "@/app/actions/invite";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVALIDATE_PATH = "/dashboard/custom-prices";

/**
 * 시크릿 딜 상품을 특정 거래처(고객)에게만 노출되도록 지정.
 * 상품 하나에 한 건도 지정하지 않으면(기본값) 거래중인 모든 고객에게 그대로
 * 노출된다 — 이 테이블은 화이트리스트로 좁힐 때만 쓴다 (lib/shop/catalog.ts 참고).
 */
export async function addSecretDealVisibilityAction(
  retailerId: string,
  productId: string
): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(retailerId) || !UUID_PATTERN.test(productId)) {
      return { success: false, error: "고객(소매)과 상품을 올바르게 선택해주세요." };
    }

    try {
      await requireOrgRole(["owner", "manager"]);
    } catch (err) {
      return { success: false, error: err instanceof RbacError ? err.message : "권한이 없습니다." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const { data: product } = await supabase
      .from("products")
      .select("id, is_secret_deal")
      .eq("id", productId)
      .eq("wholesaler_id", scope.wholesalerId)
      .maybeSingle();

    if (!product) {
      return { success: false, error: "해당 상품을 찾을 수 없습니다." };
    }

    if (!product.is_secret_deal) {
      return { success: false, error: "시크릿 딜 상품에만 노출 대상을 지정할 수 있습니다." };
    }

    const { data: relation } = await supabase
      .from("wholesaler_retailers")
      .select("id, status")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("retailer_id", retailerId)
      .maybeSingle();

    if (!relation || relation.status !== "active") {
      return { success: false, error: "거래 중인 고객(소매)이 아닙니다." };
    }

    const { error } = await supabase.from("secret_deal_visibility").insert({
      wholesaler_id: scope.wholesalerId,
      product_id: productId,
      retailer_id: retailerId,
    });

    if (error) {
      if (error.code === "23505") {
        return { success: false, error: "이미 지정된 고객(소매)입니다." };
      }

      return { success: false, error: error.message ?? "노출 대상 지정에 실패했습니다." };
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "노출 대상 지정 중 오류가 발생했습니다.",
    };
  }
}

/** 지정된 노출 대상 해제 — 남은 지정이 0건이 되면 그 상품은 다시 전체 고객에게 노출된다. */
export async function removeSecretDealVisibilityAction(id: string): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(id)) {
      return { success: false, error: "올바른 지정 식별자가 아닙니다." };
    }

    try {
      await requireOrgRole(["owner", "manager"]);
    } catch (err) {
      return { success: false, error: err instanceof RbacError ? err.message : "권한이 없습니다." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const { error } = await supabase
      .from("secret_deal_visibility")
      .delete()
      .eq("id", id)
      .eq("wholesaler_id", scope.wholesalerId);

    if (error) {
      return { success: false, error: error.message ?? "지정 해제에 실패했습니다." };
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "지정 해제 중 오류가 발생했습니다.",
    };
  }
}
