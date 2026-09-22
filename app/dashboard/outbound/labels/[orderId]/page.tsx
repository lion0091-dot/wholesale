import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { renderCode128Svg } from "@/lib/livestock/code128";
import { PrintButton } from "@/components/print-button";

export const metadata = {
  title: "출고 라벨 | 도매업체 통합관리시스템",
};

interface LabelSourceTrace {
  traceNo: string;
  productName: string;
  weight: number;
  grade: string | null;
  slaughterDate: string | null;
  butcheryPlace: string | null;
}

interface LabelRow {
  productName: string;
  traceNo: string;
  quantity: number;
  unit: string;
  grade: string | null;
  origin: string;
  slaughterDate: string | null;
  packingDate: string | null;
  butcheryPlace: string | null;
  supplierName: string;
  orderNumber: string;
  retailerName: string;
  /** 자체 세트 박스인가 — 이 경우 traceNo가 세트번호이고 구성 이력번호가 따로 있다. */
  isBundle: boolean;
  /** 세트 박스의 실중량 합계 (일반 박스는 null) */
  totalWeight: number | null;
  bestBefore: string | null;
  sourceTraces: LabelSourceTrace[];
}

function formatDate(value: string | null): string {
  return value ? value.replace(/-/g, ".").slice(2) : "-";
}

/**
 * 소분해서 나가는 봉지에 붙일 라벨.
 *
 * 박스를 통째로 주지 않고 잘라서 줄 때, 원래 이력번호를 표시해야 한다(이력제).
 * 박스에 붙어 있던 라벨은 창고에 남으므로 새 봉지용 라벨이 필요하다.
 *
 * 바코드는 라이브러리 없이 직접 그린다(npm 차단). 실제 스캐너 판독은 확인 못
 * 했으므로 이력번호를 큰 글자로 함께 찍어 — 바코드가 안 읽혀도 표시 의무는
 * 충족되고 사람이 옮겨 적을 수 있다.
 */
export default async function OrderLabelsPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const { orderId } = await params;

  let labels: LabelRow[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const { data } = await supabase.rpc("get_order_labels", { p_order_id: orderId });

    labels = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      productName: String(row.product_name ?? ""),
      traceNo: String(row.trace_no ?? ""),
      quantity: Number(row.quantity ?? 0),
      unit: String(row.unit ?? "kg"),
      grade: (row.grade as string | null) ?? null,
      origin: String(row.origin ?? ""),
      slaughterDate: (row.slaughter_date as string | null) ?? null,
      packingDate: (row.packing_date as string | null) ?? null,
      butcheryPlace: (row.butchery_place as string | null) ?? null,
      supplierName: String(row.supplier_name ?? ""),
      orderNumber: String(row.order_number ?? ""),
      retailerName: String(row.retailer_name ?? ""),
      isBundle: Boolean(row.is_bundle),
      totalWeight: row.total_weight === null || row.total_weight === undefined ? null : Number(row.total_weight),
      bestBefore: (row.best_before as string | null) ?? null,
      sourceTraces: ((row.source_traces ?? []) as Array<Record<string, unknown>>).map((trace) => ({
        traceNo: String(trace.trace_no),
        productName: String(trace.product_name ?? ""),
        weight: Number(trace.weight),
        grade: (trace.grade as string | null) ?? null,
        slaughterDate: (trace.slaughter_date as string | null) ?? null,
        butcheryPlace: (trace.butchery_place as string | null) ?? null,
      })),
    }));
  }

  if (labels.length === 0) {
    return (
      <div style={{ padding: "20px", fontSize: "14px", color: "#64748b" }}>
        출고된 박스가 없습니다. 출고 스캔을 먼저 하거나, 발주서를 확정해주세요.
      </div>
    );
  }

  const header = labels[0];

  return (
    <div>
      {/* 인쇄할 때는 화면용 머리말과 버튼을 뺀다. */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .label { break-inside: avoid; page-break-inside: avoid; }
          body { margin: 0; }
        }
      `}</style>

      <div className="no-print" style={{ marginBottom: "14px" }}>
        <h1 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: "0 0 4px" }}>
          출고 라벨 · {header.orderNumber}
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "0 0 10px" }}>
          {header.retailerName} · {labels.length}장. 소분해서 나가는 봉지에 붙이세요.
        </p>
        <PrintButton />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        {labels.map((label, index) => {
          const barcode = renderCode128Svg(label.traceNo, { moduleWidth: 2, height: 40 });

          return (
            <div
              key={`${label.traceNo}-${index}`}
              className="label"
              style={{
                width: "280px",
                border: "1px solid #0f172a",
                borderRadius: "4px",
                padding: "10px 12px",
                backgroundColor: "#fff",
                fontSize: "12px",
                color: "#0f172a",
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: "14px" }}>
                {label.isBundle && (
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      backgroundColor: "#ede9fe",
                      color: "#5b21b6",
                      borderRadius: "3px",
                      padding: "2px 5px",
                      marginRight: "4px",
                    }}
                  >
                    세트
                  </span>
                )}
                {label.productName}
              </div>

              <div style={{ color: "#475569" }}>
                {label.origin}
                {label.grade ? ` · ${label.grade}` : ""}
              </div>

              <div style={{ fontWeight: 800, fontSize: "16px", margin: "4px 0" }}>
                {label.quantity}
                {label.unit}
                {label.isBundle && label.totalWeight !== null && (
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "#475569" }}>
                    {" "}
                    · 실중량 {label.totalWeight}kg
                  </span>
                )}
              </div>

              {barcode && (
                <div
                  style={{ margin: "4px 0" }}
                  // 서버에서 만든 정적 SVG다(외부 입력이 값으로만 들어가고 태그는 우리가 만든다).
                  dangerouslySetInnerHTML={{ __html: barcode }}
                />
              )}

              <div style={{ fontFamily: "monospace", fontSize: "13px", fontWeight: 700, letterSpacing: "0.5px" }}>
                {label.traceNo}
              </div>

              {label.isBundle ? (
                /* 세트 박스는 안에 여러 마리가 들어 있다 — 라벨 한 장에 전부 찍어야
                   박스를 열어보지 않고도 이력이 확인된다(이력제 표시 의무). */
                <div style={{ fontSize: "10px", color: "#475569", marginTop: "4px" }}>
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>구성 이력번호</div>
                  {label.sourceTraces.map((trace) => (
                    <div key={trace.traceNo} style={{ fontFamily: "monospace" }}>
                      {trace.traceNo} · {trace.productName} {trace.weight}kg
                      {trace.grade ? ` · ${trace.grade}` : ""}
                    </div>
                  ))}
                  {label.bestBefore && (
                    <div style={{ fontFamily: "inherit" }}>유통기한 {formatDate(label.bestBefore)}</div>
                  )}
                </div>
              ) : (
                <div style={{ color: "#475569", fontSize: "11px", marginTop: "4px" }}>
                  도축 {formatDate(label.slaughterDate)}
                  {label.packingDate ? ` · 포장 ${formatDate(label.packingDate)}` : ""}
                  {label.butcheryPlace ? ` · ${label.butcheryPlace}` : ""}
                </div>
              )}

              <div style={{ color: "#64748b", fontSize: "11px", borderTop: "1px solid #e2e8f0", marginTop: "6px", paddingTop: "4px" }}>
                {label.supplierName} → {label.retailerName} · {label.orderNumber}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
