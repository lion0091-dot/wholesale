"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import type { ActionResult } from "@/app/actions/invite";

export interface CreatePlatformEventInput {
  name: string;
  discountRate: number;
  eventType: "common" | "individual";
  /** YYYY-MM-DD */
  startsOn: string;
  durationDays: number;
  /** eventType === 'individual'일 때만 사용. discountRate가 null이면 이벤트 기본 할인율 적용. */
  supplierRates?: Array<{ wholesalerId: string; discountRate: number | null }>;
}

const REVALIDATE_PATHS = ["/admin/events", "/admin/suppliers", "/dashboard/billing", "/"];

function revalidateBillingSurfaces() {
  for (const path of REVALIDATE_PATHS) {
    revalidatePath(path);
  }
}

/**
 * 플랫폼 할인 이벤트 생성. 한 번 만들면 수정 불가 — 취소(cancelPlatformEventAction)만
 * 가능하다(이력 보존 목적, docs/platform-subscription-billing.md 참고 흐름과 동일하게
 * "관리자가 수동으로 확정하는" 운영 방식을 따른다).
 */
export async function createPlatformEventAction(
  input: CreatePlatformEventInput
): Promise<ActionResult> {
  try {
    if (!(await isSuperAdminSession())) {
      return { success: false, error: "권한이 없습니다." };
    }

    const name = input.name.trim();

    if (!name) {
      return { success: false, error: "이벤트 이름을 입력해주세요." };
    }

    if (!Number.isFinite(input.discountRate) || input.discountRate < 0 || input.discountRate > 100) {
      return { success: false, error: "할인율은 0~100 사이여야 합니다." };
    }

    if (!Number.isFinite(input.durationDays) || input.durationDays <= 0) {
      return { success: false, error: "기간(일수)은 1 이상이어야 합니다." };
    }

    if (!input.startsOn) {
      return { success: false, error: "시작일을 입력해주세요." };
    }

    if (input.eventType === "individual" && (!input.supplierRates || input.supplierRates.length === 0)) {
      return { success: false, error: "개별 이벤트는 대상 업체를 하나 이상 선택해주세요." };
    }

    for (const row of input.supplierRates ?? []) {
      if (row.discountRate !== null && (row.discountRate < 0 || row.discountRate > 100)) {
        return { success: false, error: "업체별 할인율은 0~100 사이여야 합니다." };
      }
    }

    const supabase = await createClient();

    const { data: event, error } = await supabase
      .from("platform_events")
      .insert({
        name,
        discount_rate: input.discountRate,
        event_type: input.eventType,
        starts_on: input.startsOn,
        duration_days: input.durationDays,
      })
      .select("id")
      .single();

    if (error || !event) {
      return { success: false, error: error?.message ?? "이벤트 생성에 실패했습니다." };
    }

    if (input.eventType === "individual" && input.supplierRates && input.supplierRates.length > 0) {
      const rows = input.supplierRates.map((row) => ({
        event_id: event.id as string,
        wholesaler_id: row.wholesalerId,
        discount_rate: row.discountRate,
      }));

      const { error: mappingError } = await supabase.from("platform_event_suppliers").insert(rows);

      if (mappingError) {
        // 대상 업체 저장에 실패하면 "생성됐지만 아무한테도 안 걸리는" 반쪽 이벤트가
        // 남는 걸 막기 위해 방금 만든 이벤트를 바로 취소 처리한다.
        await supabase.rpc("cancel_platform_event", { p_event_id: event.id });
        return { success: false, error: mappingError.message ?? "대상 업체 저장에 실패했습니다." };
      }
    }

    revalidateBillingSurfaces();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "이벤트 생성 중 오류가 발생했습니다.",
    };
  }
}

/** 이벤트 취소 — status만 바꾸는 RPC(cancel_platform_event)를 통해서만 가능하다. */
export async function cancelPlatformEventAction(eventId: string): Promise<ActionResult> {
  try {
    if (!(await isSuperAdminSession())) {
      return { success: false, error: "권한이 없습니다." };
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("cancel_platform_event", { p_event_id: eventId });

    if (error) {
      return {
        success: false,
        error:
          error.message === "EVENT_NOT_FOUND_OR_ALREADY_CANCELLED"
            ? "이미 취소됐거나 존재하지 않는 이벤트입니다."
            : error.message ?? "이벤트 취소에 실패했습니다.",
      };
    }

    revalidateBillingSurfaces();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "이벤트 취소 중 오류가 발생했습니다.",
    };
  }
}
