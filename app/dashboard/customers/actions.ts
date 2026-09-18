"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import {
  sendCreditLimitChangedNotificationToWholesaler,
  sendCreditLimitIncreasedNotificationToRetailer,
  sendRetailerBlockedNotificationToRetailer,
  sendRetailerBlockedNotificationToWholesaler,
  sendRetailerResumedNotificationToRetailer,
  sendRetailerResumedNotificationToWholesaler,
} from "@/lib/notifications/alimtalk";
import type { ActionResult } from "@/app/actions/invite";

const VALID_PAYMENT_METHODS = ["prepaid", "on_credit", "pg"];

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** 여신 한도/거래상태 변경 내부 알림에 공통으로 쓰는 "처리자 이름" 조회. */
async function resolveActorName(
  supabase: SupabaseServerClient,
  wholesalerId: string,
  actorUserId: string
): Promise<string> {
  const { data: members } = await supabase.rpc("list_wholesaler_member_names", {
    p_wholesaler_id: wholesalerId,
  });

  return (
    ((members ?? []) as Array<{ user_id: string; name: string | null }>).find(
      (member) => member.user_id === actorUserId
    )?.name || "담당자"
  );
}

/** 공급사 대표(wholesalers.profile_id)의 연락처 — 내부 알림톡 수신 번호. */
async function resolveWholesalerPhone(
  supabase: SupabaseServerClient,
  wholesalerId: string
): Promise<string | undefined> {
  const { data: wholesalerRow } = await supabase
    .from("wholesalers")
    .select("profile_id")
    .eq("id", wholesalerId)
    .maybeSingle();

  if (!wholesalerRow) {
    return undefined;
  }

  const { data: ownerProfile } = await supabase
    .from("profiles")
    .select("phone")
    .eq("id", wholesalerRow.profile_id as string)
    .maybeSingle();

  return (ownerProfile?.phone as string | undefined) ?? undefined;
}

/**
 * 거래처(바이어)의 여신 한도 / 연체 기준일 / 허용 결제수단 수정. 돈과 직결되는
 * 조작이라 owner/manager만 허용한다(RLS도 20260930000019에서 동일 기준으로 맞춰둠).
 *
 * allowedPaymentMethods는 "공급사가 이 방식을 열어줬는가"만 나타낸다 — 외상은
 * creditLimit>0일 때만, PG는 wholesalers.pg_client_key가 설정돼 있을 때만 실제로
 * 체크아웃에 노출된다(전체 조건은 checkout-view.tsx에서 다시 검증).
 */
export async function updateCreditLimitAction(
  retailerId: string,
  creditLimit: number,
  settlementDueDays: number,
  allowedPaymentMethods: string[]
): Promise<ActionResult> {
  try {
    if (!Number.isFinite(creditLimit) || creditLimit < 0) {
      return { success: false, error: "여신 한도는 0 이상의 숫자여야 합니다." };
    }

    if (!Number.isFinite(settlementDueDays) || settlementDueDays <= 0) {
      return { success: false, error: "연체 기준일은 1 이상의 숫자여야 합니다." };
    }

    const methods = allowedPaymentMethods.filter((method) => VALID_PAYMENT_METHODS.includes(method));

    if (methods.length === 0) {
      return { success: false, error: "허용할 결제수단을 하나 이상 선택해주세요." };
    }

    let actorUserId: string;

    try {
      actorUserId = (await requireOrgRole(["owner", "manager"])).userId;
    } catch (err) {
      return { success: false, error: err instanceof RbacError ? err.message : "권한이 없습니다." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    // 알림톡 발송 여부 판단(한도가 실제로 바뀌었는지)을 위해 갱신 전 값을 먼저 읽는다.
    const { data: before } = await supabase
      .from("wholesaler_retailers")
      .select("credit_limit")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("retailer_id", retailerId)
      .maybeSingle();

    const previousLimit = before ? Number(before.credit_limit ?? 0) : null;

    const { data, error } = await supabase
      .from("wholesaler_retailers")
      .update({
        credit_limit: creditLimit,
        settlement_due_days: settlementDueDays,
        allowed_payment_methods: methods,
      })
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("retailer_id", retailerId)
      .select("id")
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message ?? "여신 한도 저장에 실패했습니다." };
    }

    if (!data) {
      return { success: false, error: "해당 거래처를 찾을 수 없습니다." };
    }

    revalidatePath("/dashboard/customers");
    revalidatePath("/dashboard/receivables");

    // 미설정/발송 실패는 저장 자체를 막지 않는다(알림톡은 부가 기능).
    if (previousLimit !== null && creditLimit !== previousLimit) {
      const { data: retailer } = await supabase
        .from("retailers")
        .select("restaurant_name, profile_id")
        .eq("id", retailerId)
        .maybeSingle();

      const retailerName = (retailer?.restaurant_name as string | undefined) ?? "거래처";

      // 한도를 "올려준" 경우에만 거래처 본인에게도 알림톡 발송 — 하향은 알림 대상이
      // 아니다(사용자 결정: 상향만 "주문 가능" 소식으로 통지, 정확한 금액은 넣지 않는다).
      if (retailer && creditLimit > previousLimit) {
        const { data: retailerProfile } = await supabase
          .from("profiles")
          .select("phone")
          .eq("id", retailer.profile_id as string)
          .maybeSingle();

        await sendCreditLimitIncreasedNotificationToRetailer({
          wholesalerId: scope.wholesalerId,
          wholesalerName: scope.businessName,
          retailerName,
          retailerPhone: (retailerProfile?.phone as string | undefined) ?? undefined,
        });
      }

      // 상향/하향 모두 "누가 바꿨는지" 공급사 대표에게 통지 — 감사 목적이라 방향과
      // 무관하게 발송한다.
      const [actorName, wholesalerPhone] = await Promise.all([
        resolveActorName(supabase, scope.wholesalerId, actorUserId),
        resolveWholesalerPhone(supabase, scope.wholesalerId),
      ]);

      await sendCreditLimitChangedNotificationToWholesaler({
        wholesalerId: scope.wholesalerId,
        wholesalerName: scope.businessName,
        wholesalerPhone,
        actorName,
        retailerName,
        previousLimit,
        newLimit: creditLimit,
      });
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "여신 한도 저장 중 오류가 발생했습니다.",
    };
  }
}

const RETAILER_STATUS_ERROR_MESSAGES: Record<string, string> = {
  NOT_A_WHOLESALER: "공급사 계정에서만 사용할 수 있습니다.",
  INVALID_STATUS: "잘못된 상태 값입니다.",
  BLOCK_REASON_REQUIRED: "거래중지 사유를 입력해주세요.",
  RETAILER_NOT_FOUND: "해당 거래처를 찾을 수 없습니다.",
  STATUS_UNCHANGED: "이미 해당 상태입니다.",
};

/**
 * 거래처 거래중지/재개. 실제 검증(정지 시 사유 필수)은 DB 함수(set_wholesaler_retailer_status)에서
 * 수행한다(과금 기준이 실발주로 전환되어 7일 재개 냉각기간은 제거됨).
 * 돈과 직결되는 조작이라 여신 한도와 동일하게 owner/manager만 허용.
 */
export async function updateRetailerStatusAction(
  retailerId: string,
  status: "active" | "blocked",
  reason?: string
): Promise<ActionResult> {
  try {
    let actorUserId: string;

    try {
      actorUserId = (await requireOrgRole(["owner", "manager"])).userId;
    } catch (err) {
      return { success: false, error: err instanceof RbacError ? err.message : "권한이 없습니다." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const { error } = await supabase.rpc("set_wholesaler_retailer_status", {
      p_retailer_id: retailerId,
      p_status: status,
      p_reason: reason ?? null,
    });

    if (error) {
      return {
        success: false,
        error: RETAILER_STATUS_ERROR_MESSAGES[error.message] ?? "상태 변경에 실패했습니다.",
      };
    }

    revalidatePath("/dashboard/customers");

    // 미설정/발송 실패는 상태 변경 자체를 막지 않는다(알림톡은 부가 기능).
    const { data: retailer } = await supabase
      .from("retailers")
      .select("restaurant_name, profile_id")
      .eq("id", retailerId)
      .maybeSingle();

    const retailerName = (retailer?.restaurant_name as string | undefined) ?? "거래처";

    const [retailerProfile, actorName, wholesalerPhone] = await Promise.all([
      retailer
        ? supabase.from("profiles").select("phone").eq("id", retailer.profile_id as string).maybeSingle()
        : Promise.resolve({ data: null }),
      resolveActorName(supabase, scope.wholesalerId, actorUserId),
      resolveWholesalerPhone(supabase, scope.wholesalerId),
    ]);

    const retailerPhone = (retailerProfile.data?.phone as string | undefined) ?? undefined;

    if (status === "blocked") {
      await Promise.all([
        sendRetailerBlockedNotificationToWholesaler({
          wholesalerId: scope.wholesalerId,
          wholesalerName: scope.businessName,
          wholesalerPhone,
          actorName,
          retailerName,
          reason: reason?.trim() ?? "",
        }),
        sendRetailerBlockedNotificationToRetailer({
          wholesalerId: scope.wholesalerId,
          wholesalerName: scope.businessName,
          retailerName,
          retailerPhone,
        }),
      ]);
    } else {
      await Promise.all([
        sendRetailerResumedNotificationToWholesaler({
          wholesalerId: scope.wholesalerId,
          wholesalerName: scope.businessName,
          wholesalerPhone,
          actorName,
          retailerName,
        }),
        sendRetailerResumedNotificationToRetailer({
          wholesalerId: scope.wholesalerId,
          wholesalerName: scope.businessName,
          retailerName,
          retailerPhone,
        }),
      ]);
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "상태 변경 중 오류가 발생했습니다.",
    };
  }
}
