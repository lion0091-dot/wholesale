"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { WholesalerStatus, SubscriptionStatus } from "@/types/database";

export interface ActionResult {
  success: boolean;
  error?: string;
}

export async function updateWholesalerStatusAction(
  wholesalerId: string,
  newStatus: WholesalerStatus
): Promise<ActionResult> {
  try {
    const supabase = await createClient();

    const { error } = await supabase
      .from("wholesalers")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", wholesalerId);

    if (error) {
      console.warn("[Admin Wholesaler Status] DB 업데이트 오류 (데모 모드 동작):", error.message);
    }

    revalidatePath("/admin/wholesalers");
    return { success: true };
  } catch (err: unknown) {
    console.error("[Admin Wholesaler Status ERROR]", err);
    return { success: false, error: "상태 변경 처리 중 오류가 발생했습니다." };
  }
}

export async function updateWholesalerSubscriptionAction(
  wholesalerId: string,
  newSubscriptionStatus: SubscriptionStatus
): Promise<ActionResult> {
  try {
    const supabase = await createClient();

    const { error } = await supabase
      .from("wholesalers")
      .update({ subscription_status: newSubscriptionStatus, updated_at: new Date().toISOString() })
      .eq("id", wholesalerId);

    if (error) {
      console.warn("[Admin Subscription Status] DB 업데이트 오류 (데모 모드 동작):", error.message);
    }

    revalidatePath("/admin/wholesalers");
    return { success: true };
  } catch (err: unknown) {
    console.error("[Admin Subscription Status ERROR]", err);
    return { success: false, error: "구독 상태 변경 처리 중 오류가 발생했습니다." };
  }
}
