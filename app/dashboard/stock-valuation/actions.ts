"use server";

import { createClient } from "@/lib/supabase/server";
import { fetchValuationBoxes, type ValuationBoxRow } from "@/lib/supplier/inventory-valuation";

export interface ValuationBoxesResult {
  success: boolean;
  error?: string;
  boxes?: ValuationBoxRow[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 상품을 펼칠 때 그 상품의 남은 박스를 오래된 순으로 불러온다. 권한은 DB 함수(원가 관리 접근 검사)가 정한다. */
export async function loadValuationBoxesAction(productId: string): Promise<ValuationBoxesResult> {
  if (!UUID_PATTERN.test(productId)) {
    return { success: false, error: "상품을 확인할 수 없습니다." };
  }

  const boxes = await fetchValuationBoxes(await createClient(), productId);

  if (!boxes) {
    return { success: false, error: "박스 목록을 불러오지 못했습니다. 이 기능을 쓸 수 있는지 확인해 주세요." };
  }

  return { success: true, boxes };
}
