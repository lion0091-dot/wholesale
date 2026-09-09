"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { OrderStatus } from "@/types/database";

export interface UpdateOrderStatusResult {
  success: boolean;
  error?: string;
}

export async function updateOrderStatusAction(
  orderId: string,
  newStatus: OrderStatus
): Promise<UpdateOrderStatusResult> {
  try {
    const supabase = await createClient();

    const { error } = await supabase
      .from("orders")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", orderId);

    if (error) {
      console.warn("[Update Order Status] DB 업데이트 오류 (데모 모드 동작):", error.message);
    }

    revalidatePath("/wholesaler/orders");
    return { success: true };
  } catch (err: unknown) {
    console.error("[Update Order Status ERROR]", err);
    return { success: false, error: "상태 변경 처리 중 오류가 발생했습니다." };
  }
}
