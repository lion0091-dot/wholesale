import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import {
  BundleManagerView,
  type BundleRow,
  type AssemblyRow,
  type ComponentOption,
} from "./bundle-manager-view";

export const metadata = {
  title: "세트 상품 | 도매업체 통합관리시스템",
};

/**
 * 자체 세트 상품(BOM) 관리 화면.
 *
 * 세트 상품 자체는 그냥 products 한 행이라 미니샵·발주·명세서가 그대로 돈다.
 * 이 화면이 하는 일은 "세트 1개에 무엇이 얼마나 들어가는가"를 정의하고,
 * 실제로 박스를 싸면서 **어느 이력번호의 고기가 들어갔는지**를 묶어 남기는 것이다.
 */
export default async function BundlesPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let bundles: BundleRow[] = [];
  let assemblies: AssemblyRow[] = [];
  let components: ComponentOption[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: bundleRows }, { data: assemblyRows }, { data: productRows }] = await Promise.all([
      supabase.rpc("list_product_bundles"),
      supabase.rpc("list_bundle_assemblies", { p_bundle_id: null, p_limit: 50 }),
      supabase
        .from("products")
        .select("id, name, category, unit, stock_quantity")
        .eq("wholesaler_id", scope.wholesalerId)
        .is("archived_at", null)
        .order("name", { ascending: true }),
    ]);

    bundles = ((bundleRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      bundleId: String(row.bundle_id),
      bundleCode: String(row.bundle_code),
      productId: String(row.product_id),
      productName: String(row.product_name),
      basePrice: Number(row.base_price),
      isActive: Boolean(row.is_active),
      stockQuantity: Number(row.stock_quantity),
      memo: (row.memo as string | null) ?? null,
      buildable: Number(row.buildable ?? 0),
      onHandSets: Number(row.on_hand_sets ?? 0),
      components: ((row.components ?? []) as Array<Record<string, unknown>>).map((item) => ({
        productId: String(item.product_id),
        productName: String(item.product_name),
        quantity: Number(item.quantity),
        unit: String(item.unit ?? "kg"),
        available: Number(item.available ?? 0),
      })),
    }));

    assemblies = ((assemblyRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      assemblyId: String(row.assembly_id),
      bundleId: String(row.bundle_id),
      bundleCode: String(row.bundle_code),
      setNo: String(row.set_no),
      productName: String(row.product_name),
      totalWeight: Number(row.total_weight),
      bestBefore: (row.best_before as string | null) ?? null,
      status: String(row.status),
      remaining: Number(row.remaining ?? 0),
      assembledBy: (row.assembled_by as string | null) ?? null,
      createdAt: String(row.created_at),
      sourceTraces: ((row.source_traces ?? []) as Array<Record<string, unknown>>).map((trace) => ({
        traceNo: String(trace.trace_no),
        productName: String(trace.product_name ?? ""),
        weight: Number(trace.weight),
        grade: (trace.grade as string | null) ?? null,
        slaughterDate: (trace.slaughter_date as string | null) ?? null,
      })),
    }));

    // 세트 상품 자체는 구성품 후보에서 뺀다 — 중첩 세트는 금지다.
    const bundleProductIds = new Set(bundles.map((bundle) => bundle.productId));

    components = ((productRows ?? []) as Array<Record<string, unknown>>)
      .filter((row) => !bundleProductIds.has(String(row.id)))
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        category: String(row.category),
        unit: String(row.unit),
        stockQuantity: Number(row.stock_quantity),
      }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>세트 상품</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          여러 부위를 묶어 자체 세트로 팝니다. 세트를 만들 때 들어간 고기의 <strong>이력번호</strong>를
          박스별로 묶어 기록하므로, 나중에 이력 추적이 들어오면 세트번호 하나로 역추적됩니다.
        </p>
      </header>

      <BundleManagerView bundles={bundles} assemblies={assemblies} components={components} />
    </div>
  );
}
