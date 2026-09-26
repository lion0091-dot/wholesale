import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { loadInboundData } from "../inbound-data";
import { InboundDocumentPanel } from "../inbound-document-panel";
import { InboundImportPanel } from "../inbound-import-panel";
import { pickInboundNextStep } from "@/lib/livestock/inbound-next-step";
import { InboundNextStepCard } from "../inbound-next-step-card";
import { InboundTabs } from "../../section-tabs";
import Link from "next/link";

export const metadata = {
  title: "전표입력 | 도매업체 통합관리시스템",
};

/** 사무실(PC)이 쓰는 입고 화면 — 공급처 전표 올리기·직접 입력·대조·마감. 박스 스캔은 입고 스캔(/dashboard/inbound). */
export default async function InboundStatementsPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const data = await loadInboundData(scope, { scanDetails: false });
  const partlessProductCount = data.products.filter((product) => product.name.includes("(부위 미지정)")).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <InboundTabs />

      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>전표입력</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          공급처 전표를 올리거나 직접 입력하고, 현장에서 찍은 박스와 맞춰 본 뒤 마감합니다.
          박스 스캔은 <strong>입고 스캔</strong> 화면에서 합니다.
        </p>
      </header>

      <InboundNextStepCard step={pickInboundNextStep(data.nextStepInput)} />

      {partlessProductCount > 0 && (
        <div
          style={{
            border: "1px solid #fde68a",
            backgroundColor: "#fffbeb",
            color: "#92400e",
            borderRadius: "10px",
            padding: "12px 14px",
            fontSize: "13px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <span>
            부위가 비어 있는 상품이 <strong>{partlessProductCount}개</strong> 있습니다. 부위를 채워야 정확히 관리됩니다.
          </span>
          <Link href="/dashboard/products" style={{ fontWeight: 700, color: "#1d4ed8" }}>
            상품 관리에서 채우기
          </Link>
        </div>
      )}

      <div id="inbound-documents" style={{ scrollMarginTop: "12px" }}>
        <InboundDocumentPanel
          products={data.products}
          documents={data.documents}
          canManageDocuments={data.canManage}
        />
      </div>

      <details>
        <summary style={{ fontSize: "13px", color: "#475569", cursor: "pointer", padding: "4px 0" }}>
          고급: 엑셀로 한꺼번에 입고하기
        </summary>
        <div style={{ marginTop: "10px" }}>
          <InboundImportPanel />
        </div>
      </details>
    </div>
  );
}
