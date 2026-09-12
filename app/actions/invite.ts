"use server";

import { resolveSiteOrigin } from "@/lib/auth/supplier-auth";
import { buildInviteMessage } from "@/lib/supplier/invite";
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

/**
 * 초대장 발부 — 미니샵 전용 링크 + 카카오톡 발송 문구 생성.
 *
 * 승인(is_verified) 제한을 실제로 강제하는 지점이다.
 * 화면에서 버튼을 숨기는 것만으로는 제한이 아니므로, shop_token 이 들어간
 * 링크·문구는 승인된 공급사에게만 이 액션을 통해 내려준다.
 * (미승인 상태에서는 shop_token 자체가 클라이언트로 전달되지 않는다)
 */
export async function issueInviteAction(
  customerName?: string | null
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
