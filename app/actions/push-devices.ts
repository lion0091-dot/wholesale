"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/invite";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 알림을 켠 기기 하나를 지운다(마이그레이션 227). 대표·매니저만, 같은 업체 기기만 — 권한은 DB 함수가 확인한다.
 * 지워도 그 기기에서 다시 [알림 켜기]를 누르면 돌아온다.
 */
export async function removePushDeviceAction(deviceId: string): Promise<ActionResult> {
  if (!UUID.test(deviceId)) {
    return { success: false, error: "기기를 찾을 수 없습니다." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("remove_push_device", { p_device_id: deviceId });

  if (error) {
    return {
      success: false,
      error: error.message.includes("NOT_MANAGER") ? "대표님과 매니저만 기기를 지울 수 있습니다." : "기기를 지우지 못했습니다.",
    };
  }

  if (data !== true) {
    return { success: false, error: "이미 지워졌거나 찾을 수 없는 기기입니다. 새로고침하세요." };
  }

  revalidatePath("/dashboard/invites");

  return { success: true };
}
