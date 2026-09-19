"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import { resolveSiteOrigin } from "@/lib/auth/supplier-auth";
import { describeInviteRestriction, getSupplierAccount } from "@/lib/supplier/verification";
import { buildInviteMessage } from "@/lib/supplier/invite";
import { BULK_SMS_NOT_CONFIGURED_NOTICE } from "@/lib/notifications/sms-queue";
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

/** 마지막 발송 후 이 일수가 지나야 같은 거래처를 "채우기" 버튼이 다시 큐에 채워준다. */
const INVITE_RESEND_COOLDOWN_DAYS = 30;

/**
 * 거래중(active) 거래처 전체를 초대장 문자 발송 큐(outbound_sms_queue)에 채워 넣는다.
 * 신규 거래처는 항상 포함되고, 이미 큐에 들어간 적 있는 거래처는 "대기중(pending)"이면
 * 제외, "발송완료(sent)"면 마지막 발송(sent_at)으로부터 INVITE_RESEND_COOLDOWN_DAYS일이
 * 지났을 때만 다시 포함한다(2026-09-19 결정 — 청구서처럼 버튼 한 번으로 완전 일괄이
 * 되면서도, 실수로 방금 보낸 거래처를 곧바로 또 채우는 사고는 최소 경과일로 막는다).
 * 초대장 발부는 승인된 공급사만 가능하므로 개별 발부(issueInviteAction)와 동일하게
 * describeInviteRestriction으로 막는다.
 */
export async function generateInviteSmsQueueAction(): Promise<
  ActionResult<{ insertedCount: number; skippedNoPhoneCount: number }>
> {
  try {
    const account = await getSupplierAccount();

    if (!account) {
      return { success: false, error: "로그인이 필요합니다. 카카오 로그인 후 다시 시도해주세요." };
    }

    const restriction = describeInviteRestriction(account);

    if (restriction || !account.shopToken || !account.wholesalerId) {
      return { success: false, error: restriction ?? "초대장을 발부할 수 없는 상태입니다." };
    }

    const wholesalerId = account.wholesalerId;
    const supabase = await createClient();

    const { data: relationRows, error: relationError } = await supabase
      .from("wholesaler_retailers")
      .select("retailer_id, retailers:retailer_id ( restaurant_name )")
      .eq("wholesaler_id", wholesalerId)
      .eq("status", "active");

    if (relationError) {
      return { success: false, error: relationError.message ?? "거래처 조회에 실패했습니다." };
    }

    type RelationRow = {
      retailer_id: string;
      retailers: { restaurant_name: string } | Array<{ restaurant_name: string }> | null;
    };

    const relations = (relationRows ?? []) as unknown as RelationRow[];

    if (relations.length === 0) {
      return { success: true, data: { insertedCount: 0, skippedNoPhoneCount: 0 } };
    }

    const [{ data: existingRows }, { data: phoneRows }] = await Promise.all([
      supabase
        .from("outbound_sms_queue")
        .select("retailer_id, status, sent_at")
        .eq("message_type", "retailer_invite")
        .eq("wholesaler_id", wholesalerId)
        .in(
          "retailer_id",
          relations.map((relation) => relation.retailer_id)
        )
        .order("created_at", { ascending: false }),
      supabase.rpc("list_linked_retailer_phones", { p_wholesaler_id: wholesalerId }),
    ]);

    type ExistingQueueRow = { retailer_id: string; status: "pending" | "sent"; sent_at: string | null };

    // 거래처당 여러 행(과거 발송 이력)이 있을 수 있어 created_at 내림차순으로 정렬해 받은 뒤
    // 거래처별로 가장 최근 행 하나만 남긴다.
    const latestByRetailer = new Map<string, ExistingQueueRow>();

    for (const row of (existingRows ?? []) as ExistingQueueRow[]) {
      if (!latestByRetailer.has(row.retailer_id)) {
        latestByRetailer.set(row.retailer_id, row);
      }
    }

    const resendCutoff = Date.now() - INVITE_RESEND_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

    const isEligibleForQueue = (retailerId: string): boolean => {
      const latest = latestByRetailer.get(retailerId);

      if (!latest) {
        return true;
      }

      if (latest.status === "pending" || !latest.sent_at) {
        return false;
      }

      return new Date(latest.sent_at).getTime() <= resendCutoff;
    };

    const phoneByRetailer = new Map(
      ((phoneRows ?? []) as Array<{ retailer_id: string; phone: string | null }>).map((row) => [
        row.retailer_id,
        row.phone,
      ])
    );

    const origin = await resolveSiteOrigin();
    const shopUrl = `${origin}/shop/${account.shopToken}`;
    const businessName = account.businessName ?? "공급사";

    const newRows: Array<{
      message_type: "retailer_invite";
      wholesaler_id: string;
      retailer_id: string;
      recipient_name: string;
      recipient_phone: string;
      message_body: string;
      created_by: string;
    }> = [];

    let skippedNoPhoneCount = 0;

    for (const relation of relations) {
      if (!isEligibleForQueue(relation.retailer_id)) {
        continue;
      }

      const phone = phoneByRetailer.get(relation.retailer_id);

      if (!phone) {
        skippedNoPhoneCount += 1;
        continue;
      }

      const retailer = Array.isArray(relation.retailers) ? relation.retailers[0] : relation.retailers;
      const customerName = retailer?.restaurant_name ?? null;

      newRows.push({
        message_type: "retailer_invite",
        wholesaler_id: wholesalerId,
        retailer_id: relation.retailer_id,
        recipient_name: customerName ?? "거래처",
        recipient_phone: phone,
        message_body: buildInviteMessage({ wholesalerName: businessName, shopUrl, customerName }),
        created_by: account.userId,
      });
    }

    if (newRows.length === 0) {
      return { success: true, data: { insertedCount: 0, skippedNoPhoneCount } };
    }

    // 한 번에 배치 삽입하지 않고 행마다 따로 삽입한다 — 같은 조직의 다른 직원이 거의
    // 동시에 "채우기"를 눌러 같은 거래처를 먼저 큐에 넣었다면(부분 유니크 인덱스 충돌)
    // 그 행만 실패로 건너뛰고, 나머지 무관한 거래처들은 정상적으로 큐에 들어가야 한다.
    let insertedCount = 0;

    for (const row of newRows) {
      const { error: rowInsertError } = await supabase.from("outbound_sms_queue").insert(row);

      if (!rowInsertError) {
        insertedCount += 1;
      }
    }

    revalidatePath("/dashboard/customers");

    return { success: true, data: { insertedCount, skippedNoPhoneCount } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "발송 큐 생성 중 오류가 발생했습니다.",
    };
  }
}

/**
 * 선택한 초대장 문자 큐를 일괄발송한다 — 실제로는 아직 SMS 벤더 계약이 없어 발송하지
 * 않고 안내 문구만 반환한다(app/admin/billing/actions.ts의 sendInvoiceSmsQueueAction과
 * 동일한 이유, 20260930000044 마이그레이션 주석 참고).
 */
export async function sendInviteSmsQueueAction(_ids: string[]): Promise<ActionResult> {
  const account = await getSupplierAccount();

  if (!account || describeInviteRestriction(account)) {
    return { success: false, error: "권한이 없습니다." };
  }

  return { success: false, error: BULK_SMS_NOT_CONFIGURED_NOTICE };
}

/**
 * "이 건만 직접 발송"(sms: 딥링크) 클릭 시 호출 — 해당 큐 행을 발송완료로 표시한다.
 * sent_at을 남겨야 generateInviteSmsQueueAction의 재발송 최소 경과일(30일) 기준이 동작한다.
 */
export async function markInviteSmsSentAction(queueId: string): Promise<ActionResult> {
  try {
    const account = await getSupplierAccount();

    if (!account || describeInviteRestriction(account) || !account.wholesalerId) {
      return { success: false, error: "권한이 없습니다." };
    }

    const supabase = await createClient();

    const { error } = await supabase
      .from("outbound_sms_queue")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", queueId)
      .eq("wholesaler_id", account.wholesalerId)
      .eq("message_type", "retailer_invite");

    if (error) {
      return { success: false, error: error.message ?? "발송 처리 기록에 실패했습니다." };
    }

    revalidatePath("/dashboard/customers");

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "발송 처리 기록 중 오류가 발생했습니다.",
    };
  }
}

/**
 * markInviteSmsSentAction으로 발송완료 처리된 건을 다시 대기중으로 되돌린다. 문자 앱을
 * 열었어도 실제로는 안 보냈거나 취소한 경우를 위한 수동 정정 — sent_at을 비워야
 * generateInviteSmsQueueAction의 30일 쿨다운이 풀려 곧바로 다시 채우기 대상이 된다.
 */
export async function revertInviteSmsSentAction(queueId: string): Promise<ActionResult> {
  try {
    const account = await getSupplierAccount();

    if (!account || describeInviteRestriction(account) || !account.wholesalerId) {
      return { success: false, error: "권한이 없습니다." };
    }

    const supabase = await createClient();

    const { error } = await supabase
      .from("outbound_sms_queue")
      .update({ status: "pending", sent_at: null })
      .eq("id", queueId)
      .eq("wholesaler_id", account.wholesalerId)
      .eq("message_type", "retailer_invite")
      .eq("status", "sent");

    if (error) {
      return { success: false, error: error.message ?? "되돌리기에 실패했습니다." };
    }

    revalidatePath("/dashboard/customers");

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "되돌리기 중 오류가 발생했습니다.",
    };
  }
}
