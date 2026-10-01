import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { fetchTodoCounts } from "@/lib/supplier/todo-counts";
import { fetchInternalNotices } from "@/lib/supplier/internal-notices";

export const dynamic = "force-dynamic";

/**
 * 종 배지 자동 갱신용. 로그인·업체 소속이 아니면 counts: null을 돌려준다(오류 아님).
 * 알림함(notices)은 RPC가 대표·매니저만 통과시키므로 직원에게는 빈 배열이 온다.
 */
export async function GET() {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    return NextResponse.json({ counts: null, notices: [] }, { headers: { "cache-control": "no-store" } });
  }

  const supabase = await createClient();
  const [counts, notices] = await Promise.all([
    fetchTodoCounts(supabase, scope.wholesalerId),
    fetchInternalNotices(supabase, scope.wholesalerId),
  ]);

  return NextResponse.json({ counts, notices }, { headers: { "cache-control": "no-store" } });
}
