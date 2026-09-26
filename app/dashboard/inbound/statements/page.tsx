import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { loadInboundData } from "../inbound-data";
import { InboundDocumentPanel } from "../inbound-document-panel";
import { InboundImportPanel } from "../inbound-import-panel";
import { pickInboundNextStep } from "@/lib/livestock/inbound-next-step";
import { InboundNextStepCard } from "../inbound-next-step-card";
import { InboundTabs } from "../../section-tabs";

export const metadata = {
  title: "전표입력 | 도매업체 통합관리시스템",
};

/** 사무실(PC)이 쓰는 입고 화면 — 공급처 명세서 올리기·직접 입력·대조·마감. 박스 스캔은 입고 스캔(/dashboard/inbound). */
export default async function InboundStatementsPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const data = await loadInboundData(scope, { scanDetails: false });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <InboundTabs />

      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>전표입력</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          공급처 명세서를 올리거나 직접 입력하고, 현장에서 찍은 박스와 맞춰 본 뒤 마감합니다.
          박스 스캔은 <strong>입고 스캔</strong> 화면에서 합니다.
        </p>
      </header>

      <InboundNextStepCard step={pickInboundNextStep(data.nextStepInput)} />

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
