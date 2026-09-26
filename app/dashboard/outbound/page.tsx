import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { OutboundScanView } from "./outbound-scan-view";
import { loadOutboundOrders } from "./outbound-data";

export const metadata = {
  title: "출고 스캔 | 도매업체 통합관리시스템",
};

export default async function OutboundPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const orders = await loadOutboundOrders(scope);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>출고 스캔</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          나갈 박스를 찍으면 실제로 집은 박스로 배정이 정정됩니다. 거래명세서에도 그 이력번호가 찍힙니다.
        </p>
      </header>

      <OutboundScanView orders={orders} />
    </div>
  );
}
