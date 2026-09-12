"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { requireSuperAdmin, RbacError } from "@/lib/auth/rbac";
import { isValidBusinessNumber } from "@/lib/validation/business-number";
import type { WholesalerStatus, SubscriptionStatus } from "@/types/database";

export interface ActionResult {
  success: boolean;
  error?: string;
}

const ADMIN_PATH = "/admin/suppliers";

/**
 * 슈퍼관리자 검증. 데모 모드(Supabase 미설정)에서는 DB 쓰기가 일어나지 않으므로 통과시킨다.
 * 실패 사유는 호출부에서 그대로 사용자에게 노출한다.
 */
async function assertSuperAdmin(): Promise<string | null> {
  if (!isSupabaseConfigured()) {
    return null;
  }

  try {
    await requireSuperAdmin();
    return null;
  } catch (err: unknown) {
    if (err instanceof RbacError) {
      return err.message;
    }

    throw err;
  }
}

export async function updateSupplierStatusAction(
  supplierId: string,
  newStatus: WholesalerStatus
): Promise<ActionResult> {
  try {
    const denied = await assertSuperAdmin();

    if (denied) {
      return { success: false, error: denied };
    }

    if (!isSupabaseConfigured()) {
      // 데모 모드 — 낙관적 UI 갱신만 수행한다.
      return { success: true };
    }

    const supabase = await createClient();

    // 입점 승인은 사업자등록번호 체크섬 통과가 전제 조건이다.
    if (newStatus === "active") {
      const { data: supplier } = await supabase
        .from("wholesalers")
        .select("business_number")
        .eq("id", supplierId)
        .maybeSingle();

      if (!supplier) {
        return { success: false, error: "공급사를 찾을 수 없습니다." };
      }

      if (!isValidBusinessNumber(supplier.business_number as string | null)) {
        return {
          success: false,
          error: "사업자등록번호 체크섬이 유효하지 않아 승인할 수 없습니다.",
        };
      }
    }

    const { error } = await supabase
      .from("wholesalers")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", supplierId);

    if (error) {
      console.error("[Admin Supplier Status] DB 업데이트 오류:", error.message);
      return { success: false, error: "상태 변경에 실패했습니다." };
    }

    // 계정 단위 승인 플래그(profiles.is_verified)를 함께 반영한다.
    // 이 플래그가 초대장 발부 권한을 결정하므로 업체 상태와 어긋나면 안 된다.
    // (업체 대표 + 조직 소속 직원 전원에게 전파된다)
    const { error: verificationError } = await supabase.rpc("set_supplier_verification", {
      p_wholesaler_id: supplierId,
      p_verified: newStatus === "active",
    });

    if (verificationError) {
      console.error(
        "[Admin Supplier Status] 승인 플래그 동기화 오류:",
        verificationError.message
      );
      return {
        success: false,
        error: "업체 상태는 변경되었지만 초대장 발부 권한 반영에 실패했습니다. 다시 시도해주세요.",
      };
    }

    revalidatePath(ADMIN_PATH);
    revalidatePath("/dashboard", "layout");
    return { success: true };
  } catch (err: unknown) {
    console.error("[Admin Supplier Status ERROR]", err);
    return { success: false, error: "상태 변경 처리 중 오류가 발생했습니다." };
  }
}

export async function updateSupplierSubscriptionAction(
  supplierId: string,
  newSubscriptionStatus: SubscriptionStatus
): Promise<ActionResult> {
  try {
    const denied = await assertSuperAdmin();

    if (denied) {
      return { success: false, error: denied };
    }

    if (!isSupabaseConfigured()) {
      return { success: true };
    }

    const supabase = await createClient();

    const { error } = await supabase
      .from("wholesalers")
      .update({
        subscription_status: newSubscriptionStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", supplierId);

    if (error) {
      console.error("[Admin Supplier Subscription] DB 업데이트 오류:", error.message);
      return { success: false, error: "구독 상태 변경에 실패했습니다." };
    }

    revalidatePath(ADMIN_PATH);
    return { success: true };
  } catch (err: unknown) {
    console.error("[Admin Supplier Subscription ERROR]", err);
    return { success: false, error: "구독 상태 변경 처리 중 오류가 발생했습니다." };
  }
}
