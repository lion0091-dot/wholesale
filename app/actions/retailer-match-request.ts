"use server";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/invite";

/**
 * 대문 "고객사 입점 희망" 폼 제출. 로그인 여부와 무관하게 누구나 제출할 수 있다
 * (아직 우리 시스템 계정이 없는 식당 사장님이 대상이라 로그인을 요구할 수 없음).
 * 관리자가 이 리드를 보고 적합한 공급사에 직접(전화 등) 의뢰하는 구조라, 여기서는
 * 저장만 하고 그 이상의 자동화는 없다.
 */
export interface SubmitRetailerMatchRequestInput {
  restaurantName: string;
  contactName: string;
  contactPhone: string;
  region?: string;
  desiredCategory?: string;
  monthlyVolumeHint?: string;
  memo?: string;
}

export async function submitRetailerMatchRequestAction(
  input: SubmitRetailerMatchRequestInput
): Promise<ActionResult> {
  try {
    const restaurantName = input.restaurantName?.trim() ?? "";
    const contactName = input.contactName?.trim() ?? "";
    const contactPhone = input.contactPhone?.trim() ?? "";

    if (!restaurantName || !contactName || !contactPhone) {
      return { success: false, error: "사업장명, 담당자명, 연락처는 필수 입력 사항입니다." };
    }

    const supabase = await createClient();

    const { error } = await supabase.from("retailer_match_requests").insert({
      restaurant_name: restaurantName,
      contact_name: contactName,
      contact_phone: contactPhone,
      region: input.region?.trim() || null,
      desired_category: input.desiredCategory?.trim() || null,
      monthly_volume_hint: input.monthlyVolumeHint?.trim() || null,
      memo: input.memo?.trim() || null,
    });

    if (error) {
      return { success: false, error: "신청 접수에 실패했습니다. 잠시 후 다시 시도해주세요." };
    }

    return { success: true };
  } catch {
    return { success: false, error: "신청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." };
  }
}
