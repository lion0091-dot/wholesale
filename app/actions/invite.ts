"use server";

import { createClient } from "@/lib/supabase/server";
import { resolveSiteOrigin } from "@/lib/auth/supplier-auth";
import { buildInviteMessage } from "@/lib/supplier/invite";
import { normalizePhone, isValidPhone } from "@/lib/validation/phone";
import {
  describeInviteRestriction,
  getSupplierAccount,
} from "@/lib/supplier/verification";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface IssuedInvite {
  shopUrl: string;
  message: string;
  businessName: string;
}

const CREATE_INVITE_ERROR_MESSAGES: Record<string, string> = {
  NOT_A_WHOLESALER: "공급사 계정에서만 초대장을 발부할 수 있습니다.",
  INVALID_PHONE: "전화번호를 정확히 입력해주세요(숫자 9자리 이상).",
};

/**
 * 초대장 발부 — 미니샵 전용 링크 + 카카오톡 발송 문구 생성.
 *
 * 승인(is_verified) 제한을 실제로 강제하는 지점이다.
 * 화면에서 버튼을 숨기는 것만으로는 제한이 아니므로, shop_token 이 들어간
 * 링크·문구는 승인된 공급사에게만 이 액션을 통해 내려준다.
 * (미승인 상태에서는 shop_token 자체가 클라이언트로 전달되지 않는다)
 *
 * 전화번호(phone)를 주면 이 초대가 "이 번호용"이라는 기록을 retailer_invites에
 * 남긴다(create_retailer_invite RPC) — claim_shop_access()가 손님이 로그인한
 * 카카오 전화번호와 대조해 자동승인 여부를 정한다. 링크가 제3자(경쟁사 등)에게
 * 전달되면 번호가 안 맞아 자동승인되지 않고 공급사 확인이 필요한
 * pending_review 상태로 떨어진다([[retailer-invite-espionage-risk]]).
 *
 * phone을 생략하면(이미 거래중인 고객에게 링크를 다시 보내는 경우 — 어차피
 * 활성 관계라 대조가 필요 없다) 등록 없이 링크·문구만 만든다.
 */
export async function issueInviteAction(
  customerName: string | null,
  phone?: string | null
): Promise<ActionResult<IssuedInvite>> {
  try {
    const account = await getSupplierAccount();

    if (!account) {
      return { success: false, error: "로그인이 필요합니다. 카카오 로그인 후 다시 시도해주세요." };
    }

    const restriction = describeInviteRestriction(account);

    if (restriction || !account.shopToken) {
      return {
        success: false,
        error: restriction ?? "초대장을 발부할 수 없는 상태입니다.",
      };
    }

    const normalizedPhone = normalizePhone(phone ?? "");

    if (normalizedPhone) {
      if (!isValidPhone(normalizedPhone)) {
        return { success: false, error: "전화번호를 정확히 입력해주세요(숫자 9자리 이상)." };
      }

      const supabase = await createClient();
      const { error: inviteError } = await supabase.rpc("create_retailer_invite", {
        p_phone: normalizedPhone,
        p_customer_name: customerName?.trim() || null,
      });

      if (inviteError) {
        return {
          success: false,
          error: CREATE_INVITE_ERROR_MESSAGES[inviteError.message] ?? "초대 등록에 실패했습니다.",
        };
      }
    }

    const origin = await resolveSiteOrigin();
    const shopUrl = `${origin}/shop/${account.shopToken}`;
    const businessName = account.businessName ?? "공급사";

    return {
      success: true,
      data: {
        shopUrl,
        businessName,
        message: buildInviteMessage({
          wholesalerName: businessName,
          shopUrl,
          customerName: customerName?.trim() || null,
        }),
      },
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "초대장 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    };
  }
}
