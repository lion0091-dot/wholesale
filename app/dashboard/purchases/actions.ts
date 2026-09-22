"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * 매입 금액은 원가라 현장 직원(staff)에게까지 열지 않는다. 입고 자체는 staff도
 * 하지만(현장 작업), 단가를 고치는 건 관리 행위다.
 */
const PURCHASE_ROLES: OrgRole[] = ["owner", "manager"];

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/** 박스 1건의 매입단가를 채우거나 고친다. 금액은 DB가 실중량 × 단가로 다시 계산한다. */
export async function updateInboundPurchaseAction(input: {
  scanId: string;
  unitPrice: number;
  supplierName?: string | null;
  /** 같은 상품의 기본 매입단가로도 저장할지 — 다음 스캔부터 자동으로 붙는다. */
  applyDefault?: boolean;
}): Promise<ActionResult<{ purchaseAmount: number | null }>> {
  try {
    await requireOrgRole(PURCHASE_ROLES);

    if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) {
      throw new RbacError("매입단가를 올바르게 입력해주세요.");
    }

    const supabase = await createClient();

    const { data, error } = await supabase.rpc("update_inbound_purchase", {
      p_scan_id: input.scanId,
      p_unit_price: input.unitPrice,
      p_supplier_name: input.supplierName ?? null,
      p_apply_default: input.applyDefault ?? false,
    });

    if (error) {
      if (error.message.includes("SCAN_NOT_FOUND")) {
        throw new RbacError("해당 입고 기록을 찾을 수 없습니다.");
      }

      throw new Error(error.message);
    }

    revalidatePath("/dashboard/purchases");
    revalidatePath("/dashboard/inbound");

    const row = (data ?? {}) as Record<string, unknown>;

    return {
      success: true,
      data: {
        purchaseAmount: row.purchase_amount === null || row.purchase_amount === undefined
          ? null
          : Number(row.purchase_amount),
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/** 상품별 기본 매입단가. 스캔할 때 단가를 비워두면 이 값이 따라 들어간다. */
export async function setProductPurchasePriceAction(input: {
  productId: string;
  unitPrice: number;
  supplierName?: string | null;
}): Promise<ActionResult> {
  try {
    await requireOrgRole(PURCHASE_ROLES);

    if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) {
      throw new RbacError("매입단가를 올바르게 입력해주세요.");
    }

    const supabase = await createClient();

    const { error } = await supabase.rpc("set_product_purchase_price", {
      p_product_id: input.productId,
      p_unit_price: input.unitPrice,
      p_supplier_name: input.supplierName ?? null,
    });

    if (error) {
      if (error.message.includes("PRODUCT_NOT_FOUND")) {
        throw new RbacError("상품을 찾을 수 없습니다.");
      }

      throw new Error(error.message);
    }

    revalidatePath("/dashboard/purchases");

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}
