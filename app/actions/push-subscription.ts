"use server";

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { getOrgStaffContext } from "@/lib/auth/rbac";
import { getSupplierScope } from "@/lib/supplier/scope";
import { isWebPushConfigured } from "@/lib/notifications/web-push";
import type { ActionResult } from "@/app/actions/invite";

/**
 * 웹푸시 구독 저장/해제 — 종 패널의 "이 폰으로 알림 받기" 버튼이 부른다.
 * 행은 로그인 세션으로 넣는다(RLS가 "내 계정 + 내가 속한 업체"만 통과). 발송은 서버가 service_role로 한다.
 */

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const ENDPOINT_PATTERN = /^https:\/\/[^\s]{1,2040}$/;

export async function savePushSubscriptionAction(input: PushSubscriptionInput): Promise<ActionResult> {
  try {
    if (!isWebPushConfigured()) {
      return { success: false, error: "알림 기능이 아직 설정되지 않았습니다." };
    }

    const endpoint = input?.endpoint?.trim() ?? "";
    const p256dh = input?.keys?.p256dh?.trim() ?? "";
    const auth = input?.keys?.auth?.trim() ?? "";

    if (!ENDPOINT_PATTERN.test(endpoint) || !p256dh || !auth || p256dh.length > 512 || auth.length > 256) {
      return { success: false, error: "브라우저가 준 알림 주소가 올바르지 않습니다." };
    }

    const [context, scope] = await Promise.all([getOrgStaffContext(), getSupplierScope()]);

    if (!context || !scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    // 같은 브라우저(endpoint)가 다시 켜면 덮어쓴다 — 사무실 PC 하나를 대표·매니저가 번갈아 쓰면 같은 endpoint가
    // 다른 계정 행으로 남아 있을 수 있는데, 세션(RLS)으로는 남의 행을 못 고쳐 저장이 실패한다. 그래서 위에서
    // 로그인·소속을 확인한 뒤 서버 권한으로 덮어써 현재 계정 것으로 바꾼다(user_id·wholesaler_id는 세션에서 온 값만).
    const supabase = createServiceRoleClient() ?? (await createClient());

    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: context.userId,
        wholesaler_id: scope.wholesalerId,
        endpoint,
        p256dh,
        auth,
        user_agent: null,
      },
      { onConflict: "endpoint" }
    );

    if (error) {
      return { success: false, error: "알림 설정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요." };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "알림 설정 중 오류가 발생했습니다." };
  }
}

export async function removePushSubscriptionAction(endpoint: string): Promise<ActionResult> {
  try {
    const context = await getOrgStaffContext();

    if (!context) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const supabase = await createClient();
    // RLS가 내 행만 지우게 한다. 이미 없어도 성공으로 본다(브라우저 쪽은 이미 끈 상태).
    await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint.trim());

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "알림 해제 중 오류가 발생했습니다." };
  }
}
