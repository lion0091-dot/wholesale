import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * 지금 로그인한 사람이 쓸 수 있는 기능과 업체별 세부 설정(마이그레이션 210의 my_usable_features).
 * "이 업체에서 켜져 있고, 대표이거나 대표가 허용한 사람"인 기능만 들어 있다.
 * 같은 요청 안에서는 한 번만 부른다(여러 탭·화면이 같이 물어도 DB 왕복은 1번).
 * 조회에 실패하면 빈 목록 — 기능이 안 보일 뿐 화면이 깨지지 않는다. 진짜 막는 건 각 기능의 DB 함수다.
 */
export const getMyUsableFeatures = cache(async (): Promise<Map<string, Record<string, unknown>>> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("my_usable_features");

    if (error || !Array.isArray(data)) return new Map();

    return new Map(
      (data as Array<{ feature_key: string; config: Record<string, unknown> | null }>).map((row) => [
        row.feature_key,
        row.config ?? {},
      ])
    );
  } catch {
    return new Map();
  }
});

/** 기능 키 이름 — 오타를 막으려고 한 곳에 모은다. 새 기능은 마이그레이션에서 platform_features에 등록한 키와 같게 추가한다. */
export const FEATURE_KEYS = {
  costManagement: "cost_management",
} as const;
