import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { StockTabs } from "../section-tabs";
import { StockBoxesView, type ShadowProduct } from "./stock-boxes-view";
import type { TreeBox } from "@/lib/stock/box-tree";

export const metadata = {
  title: "재고 보기 | 도매업체 통합관리시스템",
};

/** PostgREST가 한 번에 돌려주는 행 수 상한(supabase/config.toml max_rows). 박스 묶음(꼬리표 조합)이 이만큼이면 잘렸을 수 있다. */
const PAGE_SIZE = 1000;

export default async function StockBoxesPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let boxes: TreeBox[] = [];
  let products: ShadowProduct[] = [];
  let truncated = false;
  let pending = { boxes: 0, weight: 0, capped: false };

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    // 박스를 꼬리표 조합별로 DB에서 한 번에 묶어 받는다(마이그 198) — 박스 수에 상관없이 한 번, 합계도 잘리지 않는다.
    const shadowPromise = supabase.rpc("shadow_box_stock", { p_wholesaler_id: scope.wholesalerId });
    const { data: comboRows } = await supabase.rpc("stock_box_combos", { p_wholesaler_id: scope.wholesalerId });
    const boxRows = (comboRows ?? []) as Array<Record<string, unknown>>;

    const { data: shadowRows } = await shadowPromise;

    // 아직 재고에 안 들어간 박스(상품 지정·이력 확인이 남은 것). 재고 보기에는 안 잡히므로 따로 알린다.
    const { data: pendingRows, count: pendingCount } = await supabase
      .from("inbound_scans")
      .select("weight", { count: "exact" })
      .eq("wholesaler_id", scope.wholesalerId)
      .in("status", ["PENDING_MAPPING", "EXCEPTION"])
      .limit(PAGE_SIZE);

    const pendingList = (pendingRows ?? []) as Array<{ weight: number | string }>;

    pending = {
      boxes: pendingCount ?? pendingList.length,
      weight: pendingList.reduce((sum, row) => sum + Number(row.weight), 0),
      // 합계 중량은 읽어 온 행만 더한 값이라, 박스가 더 많으면 "이상"으로 표시한다.
      capped: (pendingCount ?? 0) > pendingList.length,
    };

    boxes = boxRows.map((row) => ({
      tagSpecies: (row.tag_species as string | null) ?? null,
      tagPart: (row.tag_part as string | null) ?? null,
      tagOrigin: (row.tag_origin as string | null) ?? null,
      tagGrade: (row.tag_grade as string | null) ?? null,
      tagSex: (row.tag_sex as string | null) ?? null,
      tagBms: (row.tag_bms as string | null) ?? null,
      tagStorageState: (row.tag_storage_state as string | null) ?? null,
      remainingWeight: Number(row.weight),
      boxCount: Number(row.boxes),
    }));

    truncated = boxRows.length >= PAGE_SIZE;

    products = ((shadowRows ?? []) as Array<Record<string, unknown>>)
      .map((row) => ({
        id: String(row.product_id),
        name: String(row.product_name),
        unit: (row.unit as string | null) ?? "kg",
        sureWeight: Number(row.sure_weight),
        sureBoxes: Number(row.sure_boxes),
        mixedWeight: Number(row.mixed_weight),
        mixedBoxes: Number(row.mixed_boxes),
      }))
      .filter((p) => p.sureBoxes > 0 || p.mixedBoxes > 0);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <StockTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>재고 보기</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          지금 창고에 있는 박스를 축종 → 부위 → 원산지 → 등급 순으로 접어 보여줍니다. 박스가 있는 조합만 나타나고,
          이력조회로 알 수 없는 값은 &quot;모름&quot;으로 모입니다.
        </p>
      </header>

      <StockBoxesView boxes={boxes} products={products} truncated={truncated} pending={pending} />
    </div>
  );
}
