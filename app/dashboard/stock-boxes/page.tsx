import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { StockTabs } from "../section-tabs";
import { StockBoxesView, type ShadowProduct } from "./stock-boxes-view";
import type { TreeBox } from "@/lib/stock/box-tree";

export const metadata = {
  title: "재고 보기 | 도매업체 통합관리시스템",
};

/** 트리는 화면에서 접어 보여주므로 박스 행 수천 건까지만 끌어온다(설계안 §6 부하 상한). */
const BOX_LIMIT = 5000;

/** PostgREST가 한 번에 돌려주는 행 수 상한(supabase/config.toml max_rows). 넘겨 요청해도 조용히 잘리므로 이 크기로 나눠 읽는다. */
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

    const fetchBoxPage = (from: number) =>
      supabase
        .from("inbound_scans")
        .select("tag_species, tag_part, tag_origin, tag_grade, tag_sex, tag_bms, tag_storage_state, remaining_weight")
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("status", "NORMAL")
        .gt("remaining_weight", 0)
        // 순서가 없으면 페이지 사이에 행이 겹치거나 빠진다.
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

    const shadowPromise = supabase.rpc("shadow_box_stock", { p_wholesaler_id: scope.wholesalerId });
    const boxRows: Array<Record<string, unknown>> = [];

    for (let from = 0; from < BOX_LIMIT; from += PAGE_SIZE) {
      const { data: page } = await fetchBoxPage(from);
      const rows = (page ?? []) as Array<Record<string, unknown>>;

      boxRows.push(...rows);

      if (rows.length < PAGE_SIZE) break;
    }

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
      remainingWeight: Number(row.remaining_weight),
    }));

    truncated = boxes.length >= BOX_LIMIT;

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
