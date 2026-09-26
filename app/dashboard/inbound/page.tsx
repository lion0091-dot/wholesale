import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { InboundScanView } from "./inbound-scan-view";
import { loadInboundData } from "./inbound-data";
import { isMtraceConfigured, configuredTraceSources } from "@/lib/livestock/mtrace-client";
import { pickFieldNextStep } from "@/lib/livestock/inbound-next-step";
import { InboundNextStepCard } from "./inbound-next-step-card";
import { InboundTabs } from "../section-tabs";

/** 이력 조회 기관 표기 — 설정 안내 문구에 쓴다. */
const SOURCE_LABELS: Record<string, string> = {
  mtrace: "국내산 소·돼지",
  meatwatch: "수입 축산물",
  poultry: "닭·오리·계란",
};

export const metadata = {
  title: "입고 스캔 | 도매업체 통합관리시스템",
};

/** 현장이 쓰는 입고 화면 — 명세서 올리기·대조·마감은 전표입력(/dashboard/inbound/statements). */
export default async function InboundPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const data = await loadInboundData(scope, { scanDetails: true });
  const configured = configuredTraceSources();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <InboundTabs />

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

      <InboundNextStepCard step={pickFieldNextStep(data.nextStepInput)} />

      <InboundScanView
        initialScans={data.scans}
        remainingBoxCount={data.remainingBoxCount}
        scanDocuments={data.documents
          .filter((doc) => doc.status === "PENDING")
          .map((doc) => ({ id: doc.id, scanFinished: doc.scanFinished }))}
        products={data.products}
        shippableOrders={data.shippableOrders}
        scanRequirements={data.scanRequirements}
        pendingDocumentTraceNos={data.pendingDocumentTraceNos}
        awaitingDocumentLines={data.awaitingDocumentLines}
        storageLocationSuggestions={data.storageLocationSuggestions}
        canEditPurchasePrice={data.canManage}
      />
    </div>
  );
}
