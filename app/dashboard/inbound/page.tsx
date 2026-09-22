import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { InboundScanView, type InboundScanRow, type ScanProductOption } from "./inbound-scan-view";
import { InboundImportPanel } from "./inbound-import-panel";
import { isMtraceConfigured, configuredTraceSources } from "@/lib/livestock/mtrace-client";

/** 이력 조회 기관 표기 — 설정 안내 문구에 쓴다. */
const SOURCE_LABELS: Record<string, string> = {
  mtrace: "국내산 소·돼지",
  meatwatch: "수입 축산물",
  poultry: "닭·오리·계란",
};

export const metadata = {
  title: "입고 스캔 | 도매업체 통합관리시스템",
};

export default async function InboundPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let scans: InboundScanRow[] = [];
  let products: ScanProductOption[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    // 입고 내역은 계속 쌓이기만 하므로 최근 100건만 불러온다. 현장에서 보는 건
    // "방금 찍은 것들"이고, 과거 조회는 이력관리 메뉴가 따로 담당한다.
    const [{ data: scanRows }, { data: productRows }] = await Promise.all([
      supabase
        .from("inbound_scans")
        .select("id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight, created_at")
        .eq("wholesaler_id", scope.wholesalerId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("products")
        .select("id, name, category, subcategory, grade, unit")
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("is_active", true)
        .order("name", { ascending: true }),
    ]);

    products = (productRows ?? []) as ScanProductOption[];

    const productNames = new Map(products.map((product) => [product.id, product.name]));

    scans = ((scanRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      traceNo: String(row.trace_no),
      productId: (row.product_id as string | null) ?? null,
      productName: row.product_id ? productNames.get(String(row.product_id)) ?? null : null,
      weight: Number(row.weight),
      unit: String(row.unit),
      scanType: String(row.scan_type),
      status: String(row.status) as InboundScanRow["status"],
      remainingWeight: Number(row.remaining_weight),
      createdAt: String(row.created_at),
    }));
  }

  const configured = configuredTraceSources();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>입고 스캔</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          바코드를 찍고 중량을 입력하면 이력번호를 공공 이력제와 대조해 재고에 반영합니다.
        </p>
      </header>

      {!isMtraceConfigured() ? (
        <div
          style={{
            border: "1px solid #fde68a",
            backgroundColor: "#fffbeb",
            color: "#92400e",
            borderRadius: "10px",
            padding: "12px 14px",
            fontSize: "13px",
          }}
        >
          <strong>이력 조회 인증키가 아직 없습니다.</strong> 입고 기록은 정상으로 남지만 이력 검증이
          되지 않아 “확인 필요”로 쌓입니다. 키를 등록한 뒤 다시 조회하면 채워집니다.
        </div>
      ) : (
        <div style={{ fontSize: "12px", color: "#64748b" }}>
          이력 조회 가능: {configured.map((source) => SOURCE_LABELS[source] ?? source).join(" · ")}
        </div>
      )}

      <InboundImportPanel />

      <InboundScanView initialScans={scans} products={products} />
    </div>
  );
}
