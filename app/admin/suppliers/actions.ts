"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { requireSuperAdmin, RbacError } from "@/lib/auth/rbac";
import { isValidBusinessNumber } from "@/lib/validation/business-number";
import { verifyBusinessRegistration, type NtsVerificationStatus } from "@/lib/verification/nts-business";
import type { WholesalerStatus, SubscriptionStatus } from "@/types/database";

export interface ActionResult {
  success: boolean;
  error?: string;
}

export interface NtsVerificationActionResult extends ActionResult {
  status?: NtsVerificationStatus;
  message?: string;
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

    // 입점 승인은 체크섬 통과 + 국세청 진위확인(match)이 전제 조건이다.
    // 등록증 사본 제출 여부는 승인을 막지 않는다 — 국세청 API가 이미 사업자번호·
    // 대표자명·개업일자를 실데이터와 대조하므로, 사본은 관리자가 참고용으로만
    // 대조하는 보조 자료다(제출 안 해도 승인 가능).
    if (newStatus === "active") {
      const { data: supplier } = await supabase
        .from("wholesalers")
        .select("business_number, nts_verification_status")
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

      if (supplier.nts_verification_status !== "match") {
        return {
          success: false,
          error: "국세청 진위확인이 완료(일치)되지 않아 승인할 수 없습니다. 먼저 진위확인을 실행하세요.",
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

/**
 * 국세청 진위확인 API를 호출해 사업자등록번호·대표자명·개업일자가 실제 국세청
 * 데이터와 일치하는지 확인하고 결과를 wholesalers.nts_verification_status에 저장한다.
 * 결과가 "match"여야 입점 승인(updateSupplierStatusAction)이 허용된다.
 */
export async function verifyBusinessWithNtsAction(
  supplierId: string
): Promise<NtsVerificationActionResult> {
  try {
    const denied = await assertSuperAdmin();

    if (denied) {
      return { success: false, error: denied };
    }

    if (!isSupabaseConfigured()) {
      return { success: true, status: "match", message: "데모 모드 — 실제 API 호출 없이 통과 처리." };
    }

    const supabase = await createClient();

    const { data: supplier } = await supabase
      .from("wholesalers")
      .select("business_number, representative_name, business_start_date")
      .eq("id", supplierId)
      .maybeSingle();

    if (!supplier) {
      return { success: false, error: "공급사를 찾을 수 없습니다." };
    }

    if (!isValidBusinessNumber(supplier.business_number as string | null)) {
      return { success: false, error: "사업자등록번호 체크섬이 유효하지 않습니다." };
    }

    if (!supplier.business_start_date) {
      return {
        success: false,
        error: "개업일자가 아직 제출되지 않아 진위확인을 실행할 수 없습니다.",
      };
    }

    const result = await verifyBusinessRegistration({
      businessNumber: supplier.business_number as string,
      representativeName: supplier.representative_name as string,
      startDate: supplier.business_start_date as string,
    });

    const { error: rpcError } = await supabase.rpc("set_nts_verification_result", {
      p_wholesaler_id: supplierId,
      p_status: result.status,
    });

    if (rpcError) {
      console.error("[NTS Verification] 결과 저장 오류:", rpcError.message);
      return { success: false, error: "진위확인 결과 저장에 실패했습니다." };
    }

    revalidatePath(ADMIN_PATH);

    return { success: true, status: result.status, message: result.message };
  } catch (err: unknown) {
    console.error("[NTS Verification ERROR]", err);
    return { success: false, error: "국세청 진위확인 처리 중 오류가 발생했습니다." };
  }
}

/**
 * 사업자등록증 사본 조회용 서명된 URL 발급 (슈퍼관리자 전용).
 * business-licenses 버킷은 private이라 signed URL 없이는 접근할 수 없다.
 */
export async function getBusinessLicenseUrlAction(
  supplierId: string
): Promise<ActionResult & { url?: string }> {
  try {
    const denied = await assertSuperAdmin();

    if (denied) {
      return { success: false, error: denied };
    }

    if (!isSupabaseConfigured()) {
      return { success: false, error: "데모 모드에서는 실제 파일을 조회할 수 없습니다." };
    }

    const supabase = await createClient();

    const { data: supplier } = await supabase
      .from("wholesalers")
      .select("business_license_path")
      .eq("id", supplierId)
      .maybeSingle();

    if (!supplier?.business_license_path) {
      return { success: false, error: "아직 제출된 사업자등록증이 없습니다." };
    }

    const { data, error } = await supabase.storage
      .from("business-licenses")
      .createSignedUrl(supplier.business_license_path as string, 300);

    if (error || !data?.signedUrl) {
      console.error("[Business License Signed URL] 발급 오류:", error?.message);
      return { success: false, error: "파일 조회 링크를 만들지 못했습니다." };
    }

    return { success: true, url: data.signedUrl };
  } catch (err: unknown) {
    console.error("[Business License Signed URL ERROR]", err);
    return { success: false, error: "처리 중 오류가 발생했습니다." };
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

/**
 * 공급사별 과금 시작일 지정/해제. billing_starts_at이 null이면 체험만료/연체/해지
 * 여부와 무관하게 접근 차단을 하지 않는다(자세한 배경은 lib/supplier/billing.ts 주석).
 *
 * 날짜를 지정할 때는 trial_started_at도 같은 값으로 리셋한다 — 안 그러면 신청이
 * 훨씬 이전인 원래 trial_started_at 때문에 지정하자마자 바로 차단될 수 있다.
 */
export async function setBillingStartAction(
  supplierId: string,
  billingStartsAt: string | null
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

    const update: Record<string, string | null> = {
      billing_starts_at: billingStartsAt,
      updated_at: new Date().toISOString(),
    };

    if (billingStartsAt) {
      update.trial_started_at = billingStartsAt;
    }

    const { error } = await supabase.from("wholesalers").update(update).eq("id", supplierId);

    if (error) {
      console.error("[Admin Supplier Billing Start] DB 업데이트 오류:", error.message);
      return { success: false, error: "과금 시작일 저장에 실패했습니다." };
    }

    revalidatePath(ADMIN_PATH);
    revalidatePath("/dashboard", "layout");
    return { success: true };
  } catch (err: unknown) {
    console.error("[Admin Supplier Billing Start ERROR]", err);
    return { success: false, error: "과금 시작일 저장 중 오류가 발생했습니다." };
  }
}
