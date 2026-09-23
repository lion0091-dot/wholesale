import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { listCustomPrices, type CustomPriceKind } from "@/app/actions/custom_price";
import type { HistoryPickerItem } from "./history-picker-list";

/** wholesaler_retailers + retailers 조인 응답 형태 (custom-prices/page.tsx와 동일) */
interface RelationRow {
  retailer_id: string;
  retailers: { restaurant_name: string } | { restaurant_name: string }[] | null;
}

function relationName(row: RelationRow): string {
  const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;

  return retailer?.restaurant_name ?? "이름 미등록 고객(소매)";
}

/**
 * 맞춤단가/핫딜 이력 메뉴 공용 로더 — /dashboard/custom-prices와 동일한 방식으로
 * 상품명·거래처명을 조인해 "대상 찾기" 목록을 만든다. kind로 맞춤단가/핫딜을 나눈다.
 */
export async function loadCustomPriceHistoryItems(kind: CustomPriceKind): Promise<HistoryPickerItem[]> {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    return [];
  }

  const supabase = await createClient();

  const [{ data: relations }, { data: productRows }, customPriceResult] = await Promise.all([
    supabase
      .from("wholesaler_retailers")
      .select("retailer_id, retailers ( restaurant_name )")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("status", "active"),
    supabase
      .from("products")
      .select("id, name")
      .eq("wholesaler_id", scope.wholesalerId),
    listCustomPrices(kind),
  ]);

  const customerMap = new Map(
    ((relations ?? []) as RelationRow[]).map((row) => [row.retailer_id, relationName(row)])
  );
  const productMap = new Map(
    ((productRows ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name])
  );

  const rows = customPriceResult.success ? customPriceResult.data ?? [] : [];

  return rows.map((row) => ({
    id: row.id,
    title: `${customerMap.get(row.retailer_id) ?? "거래 종료된 고객(소매)"} · ${
      productMap.get(row.product_id) ?? "삭제된 상품"
    }`,
    subtitle: `${Number(row.custom_price).toLocaleString("ko-KR")}원${row.is_active ? "" : " · 꺼짐"}`,
  }));
}
