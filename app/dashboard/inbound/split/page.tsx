import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { InboundTabs } from "../../section-tabs";
import { SplitView, type SplitBox } from "./split-view";

export const metadata = {
  title: "쪼개기 | 도매업체 통합관리시스템",
};

/** 쪼갤 수 있는 박스 목록 상한 — 오래된 것부터 아니라 최근 입고 순으로 본다. */
const BOX_LIMIT = 300;

/** PostgREST 필터 문법(쉼표·괄호)과 LIKE 와일드카드가 검색어에 섞여 필터가 깨지지 않게 걷어낸다. */
function cleanSearchTerm(value: string | undefined): string {
  return (value ?? "").replace(/[,()%*_\\]/g, " ").trim().slice(0, 40);
}

export default async function SplitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const scope = await getSupplierScope();
  const params = await searchParams;
  const rawQuery = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = cleanSearchTerm(rawQuery);

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let boxes: SplitBox[] = [];
  let parts: string[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    // 검색어가 있으면 서버에서 이력번호·상품 이름으로 찾는다 — 최근 300개 밖의 오래된 박스도 찾을 수 있게.
    let productIds: string[] = [];

    if (query) {
      const { data: matched } = await supabase
        .from("products")
        .select("id")
        .eq("wholesaler_id", scope.wholesalerId)
        .ilike("name", `%${query}%`)
        .limit(100);

      productIds = ((matched ?? []) as Array<{ id: string }>).map((row) => row.id);
    }

    let boxQuery = supabase
        .from("inbound_scans")
        .select("id, trace_no, remaining_weight, unit, created_at, products(name)")
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("status", "NORMAL")
        .gt("remaining_weight", 0)
        .is("split_at", null)
        .not("product_id", "is", null);

    if (query) {
      boxQuery = boxQuery.or(
        productIds.length > 0 ? `trace_no.ilike.%${query}%,product_id.in.(${productIds.join(",")})` : `trace_no.ilike.%${query}%`,
      );
    }

    const [{ data: boxRows }, { data: partRows }] = await Promise.all([
      boxQuery.order("created_at", { ascending: false }).limit(BOX_LIMIT),
      // 부위 드롭박스: 입고 화면과 같은 목록(이미 등록된 상품의 부위, DB가 DISTINCT로 돌려준다).
      supabase.rpc("inbound_part_options"),
    ]);

    boxes = ((boxRows ?? []) as unknown as Array<{
      id: string;
      trace_no: string;
      remaining_weight: number | string;
      unit: string | null;
      created_at: string;
      products: { name: string } | { name: string }[] | null;
    }>).map((row) => ({
      id: row.id,
      traceNo: row.trace_no,
      remainingWeight: Number(row.remaining_weight),
      unit: row.unit ?? "kg",
      createdAt: row.created_at,
      productName: (Array.isArray(row.products) ? row.products[0]?.name : row.products?.name) ?? "",
    }));

    parts = Array.from(
      new Set(
        ((partRows ?? []) as Array<{ supplier_id: string | null; part: string }>)
          .filter((row) => row.supplier_id === null)
          .map((row) => row.part),
      ),
    ).sort((a, b) => a.localeCompare(b, "ko"));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <InboundTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>쪼개기</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          지육·대분할육 박스를 부위별 박스로 나눕니다. 쪼갠 박스는 원래 이력번호를 그대로 이어받고, 원래 박스의 남은 중량과
          나눈 중량의 차이(뼈·지방·손실)는 손실로 기록됩니다.
        </p>
      </header>

      <SplitView boxes={boxes} parts={parts} initialQuery={query} />
    </div>
  );
}
