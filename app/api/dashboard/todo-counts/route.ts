import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { fetchTodoCounts } from "@/lib/supplier/todo-counts";

export const dynamic = "force-dynamic";

/** 종 배지 자동 갱신용. 로그인·업체 소속이 아니면 counts: null을 돌려준다(오류 아님). */
export async function GET() {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    return NextResponse.json({ counts: null }, { headers: { "cache-control": "no-store" } });
  }

  const supabase = await createClient();
  const counts = await fetchTodoCounts(supabase, scope.wholesalerId);

  return NextResponse.json({ counts }, { headers: { "cache-control": "no-store" } });
}
