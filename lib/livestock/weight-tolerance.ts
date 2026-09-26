import type { createClient } from "@/lib/supabase/server";
import { INBOUND_WEIGHT_TOLERANCE } from "./weight-variance";

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * 전표 줄 무게 기준 판정의 허용 오차(비율, 0.02 = ±2%) — 업체가 설정한다(마이그레이션 127).
 * 읽지 못하면 기본값(±2%)으로 판정한다. DB의 document_line_match_status와 같은 값을 써야 화면·자동 마감이 어긋나지 않는다.
 */
export async function loadWeightTolerance(supabase: Client, wholesalerId: string): Promise<number> {
  try {
    const { data } = await supabase.rpc("get_weight_tolerance", { p_wholesaler_id: wholesalerId });
    const value = Number(data);

    return Number.isFinite(value) && value > 0 ? value : INBOUND_WEIGHT_TOLERANCE;
  } catch {
    return INBOUND_WEIGHT_TOLERANCE;
  }
}
