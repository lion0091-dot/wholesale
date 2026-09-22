import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { renderCode128Svg } from "@/lib/livestock/code128";
import { PrintButton } from "@/components/print-button";

export const metadata = {
  title: "세트 라벨 | 도매업체 통합관리시스템",
};

interface SourceTrace {
  traceNo: string;
  productName: string;
  weight: number;
  grade: string | null;
  slaughterDate: string | null;
  butcheryPlace: string | null;
}

interface BundleLabel {
  assemblyId: string;
  setNo: string;
  productName: string;
  bundleCode: string;
  origin: string;
  totalWeight: number;
  bestBefore: string | null;
  supplierName: string;
  assembledAt: string;
  sourceTraces: SourceTrace[];
}

function formatDate(value: string | null): string {
  return value ? value.replace(/-/g, ".").slice(2) : "-";
}

/**
 * 세트 박스에 붙일 라벨.
 *
 * 세트에는 정부 이력번호가 하나가 아니라 여럿이다. 그래서 바코드에는 우리가
 * 발행한 세트번호를 싣고(출고 스캔이 이 번호로 박스를 찾는다), **들어간 이력번호는
 * 전부 글자로 찍는다** — 박스를 열어보지 않고도 이력이 확인돼야 이력제 표시 의무가
 * 충족되고, 단속이 들어왔을 때 라벨만으로 설명이 된다.
 */
export default async function BundleLabelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const params = await searchParams;
  const raw = Array.isArray(params.ids) ? params.ids[0] : params.ids;

  const ids = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  let labels: BundleLabel[] = [];

  if (scope?.wholesalerId && ids.length > 0) {
    const supabase = await createClient();
    const { data } = await supabase.rpc("get_bundle_labels", { p_assembly_ids: ids });

    labels = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      assemblyId: String(row.assembly_id),
      setNo: String(row.set_no),
      productName: String(row.product_name ?? ""),
      bundleCode: String(row.bundle_code ?? ""),
      origin: String(row.origin ?? ""),
      totalWeight: Number(row.total_weight ?? 0),
      bestBefore: (row.best_before as string | null) ?? null,
      supplierName: String(row.supplier_name ?? ""),
      assembledAt: String(row.assembled_at ?? ""),
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
        인쇄할 세트가 없습니다. 세트 상품 화면에서 제작한 뒤 라벨을 여세요.
      </div>
    );
  }

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
          세트 라벨 · {labels.length}장
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "0 0 10px" }}>
          세트 박스에 붙이세요. 바코드는 세트번호이고, 안에 들어간 이력번호는 아래에 모두 찍힙니다.
        </p>
        <PrintButton />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        {labels.map((label) => {
          const barcode = renderCode128Svg(label.setNo, { moduleWidth: 2, height: 40 });

          return (
            <div
              key={label.assemblyId}
              className="label"
              style={{
                width: "300px",
                border: "1px solid #0f172a",
                borderRadius: "4px",
                padding: "10px 12px",
                backgroundColor: "#fff",
                fontSize: "12px",
                color: "#0f172a",
                lineHeight: 1.5,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 800, fontSize: "14px" }}>{label.productName}</span>
                <span style={{ fontSize: "10px", color: "#64748b" }}>{label.bundleCode}</span>
              </div>

              <div style={{ color: "#475569" }}>
                {label.origin}
                {label.bestBefore ? ` · 유통기한 ${formatDate(label.bestBefore)}` : ""}
              </div>

              <div style={{ fontWeight: 800, fontSize: "16px", margin: "4px 0" }}>
                1세트 · {label.totalWeight}kg
              </div>

              {barcode && (
                <div
                  style={{ margin: "4px 0" }}
                  // 서버에서 만든 정적 SVG다(외부 입력이 값으로만 들어가고 태그는 우리가 만든다).
                  dangerouslySetInnerHTML={{ __html: barcode }}
                />
              )}

              <div style={{ fontFamily: "monospace", fontSize: "13px", fontWeight: 700, letterSpacing: "0.5px" }}>
                {label.setNo}
              </div>

              <div
                style={{
                  marginTop: "6px",
                  borderTop: "1px solid #e2e8f0",
                  paddingTop: "4px",
                  fontSize: "10px",
                  color: "#475569",
                }}
              >
                <div style={{ fontWeight: 700, color: "#0f172a" }}>구성 이력번호</div>
                {label.sourceTraces.map((trace) => (
                  <div key={trace.traceNo}>
                    <span style={{ fontFamily: "monospace" }}>{trace.traceNo}</span> · {trace.productName}{" "}
                    {trace.weight}kg
                    {trace.grade ? ` · ${trace.grade}` : ""}
                    {trace.slaughterDate ? ` · 도축 ${formatDate(trace.slaughterDate)}` : ""}
                  </div>
                ))}
              </div>

              <div
                style={{
                  color: "#64748b",
                  fontSize: "10px",
                  borderTop: "1px solid #e2e8f0",
                  marginTop: "6px",
                  paddingTop: "4px",
                }}
              >
                {label.supplierName} · 제작 {formatDate(label.assembledAt.slice(0, 10))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
