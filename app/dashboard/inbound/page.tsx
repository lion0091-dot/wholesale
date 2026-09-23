import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import {
  InboundScanView,
  type InboundScanRow,
  type ScanProductOption,
  type ShippableOrderOption,
} from "./inbound-scan-view";
import { InboundImportPanel } from "./inbound-import-panel";
import { InboundDocumentPanel, type InboundDocumentRow } from "./inbound-document-panel";
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
  let shippableOrders: ShippableOrderOption[] = [];
  let documents: InboundDocumentRow[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    // 입고 내역은 계속 쌓이기만 하므로 최근 100건만 불러온다. 현장에서 보는 건
    // "방금 찍은 것들"이고, 과거 조회는 이력관리 메뉴가 따로 담당한다.
    // 주문 목록은 출고 스캔 화면(app/dashboard/outbound/page.tsx)과 같은 기준
    // (확정·배송중만)이다 — "이 박스 특정 주문으로 바로 보내기"가 결국 출고 스캔을
    // 대신 호출하므로 같은 상태만 배정 대상이어야 한다.
    const [{ data: scanRows }, { data: productRows }, { data: orderRows }] = await Promise.all([
      supabase
        .from("inbound_scans")
        .select(
          "id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight, created_at, labeled_weight, weight_variance, purchase_unit_price, purchase_amount, purchase_supplier"
        )
        .eq("wholesaler_id", scope.wholesalerId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("products")
        .select("id, name, category, subcategory, grade, origin, unit")
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("is_active", true)
        .order("name", { ascending: true }),
      supabase
        .from("orders")
        .select("id, order_number, retailers ( restaurant_name )")
        .eq("wholesaler_id", scope.wholesalerId)
        .in("status", ["confirmed", "shipping"])
        .order("ordered_at", { ascending: true })
        .limit(50),
    ]);

    // 올린 명세서 목록. 저장만 되고 다시 열어볼 곳이 없으면 쓸모가 없어서 함께 내린다.
    // 줄 수는 행마다 세면 N+1이라 관계 count로 한 번에 받는다.
    const { data: documentRows } = await supabase
      .from("inbound_documents")
      .select(
        "id, supplier_name, document_no, issued_on, file_name, storage_path, status, total_amount, created_at, inbound_document_lines(count)"
      )
      .eq("wholesaler_id", scope.wholesalerId)
      .order("created_at", { ascending: false })
      .limit(30);

    documents = ((documentRows ?? []) as Array<Record<string, unknown>>).map((row) => {
      const counts = row.inbound_document_lines as Array<{ count: number }> | null;

      return {
        id: String(row.id),
        supplierName: (row.supplier_name as string | null) ?? null,
        documentNo: (row.document_no as string | null) ?? null,
        issuedOn: (row.issued_on as string | null) ?? null,
        fileName: (row.file_name as string | null) ?? null,
        hasFile: Boolean(row.storage_path),
        status: String(row.status),
        totalAmount: row.total_amount === null ? null : Number(row.total_amount),
        createdAt: String(row.created_at),
        lineCount: counts?.[0]?.count ?? 0,
      };
    });

    products = (productRows ?? []) as ScanProductOption[];

    shippableOrders = ((orderRows ?? []) as Array<Record<string, unknown>>).map((row) => {
      const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;

      return {
        id: String(row.id),
        orderNumber: String(row.order_number),
        retailerName:
          ((retailer as Record<string, unknown> | null)?.restaurant_name as string | null) ?? "거래처",
      };
    });

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
      labeledWeight: row.labeled_weight === null ? null : Number(row.labeled_weight),
      weightVariance: row.weight_variance === null ? null : Number(row.weight_variance),
      purchaseUnitPrice: row.purchase_unit_price === null ? null : Number(row.purchase_unit_price),
      purchaseAmount: row.purchase_amount === null ? null : Number(row.purchase_amount),
      purchaseSupplier: (row.purchase_supplier as string | null) ?? null,
    }));
  }

  const configured = configuredTraceSources();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>입고 스캔</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          바코드를 찍고 저울에 찍힌 <strong>실중량</strong>을 입력하면, 이력번호를 공공 이력제와
          대조해 재고에 반영하고 표기중량과의 차이·매입금액까지 함께 기록합니다.
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

      <InboundDocumentPanel products={products} documents={documents} />

      <InboundImportPanel />

      <InboundScanView initialScans={scans} products={products} shippableOrders={shippableOrders} />
    </div>
  );
}
