import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { InboundTabs } from "../../section-tabs";
import { ImportedLookupView } from "./imported-lookup-view";

export const metadata = {
  title: "수입육 이력 조회 | 도매업체 통합관리시스템",
};

/**
 * 수입축산물 이력 조회 — 사무실 전용 별도 도구.
 *
 * 국내산과 달리 이력번호로 바로 조회가 안 되고, 수입일자(필수)로 그날 목록을
 * 받아 그 안에서 번호가 맞는지 눈으로 대조해야 한다(meatwatch-client.ts 참고).
 * 그래서 현장 스캔 화면과 분리된 화면이다 — 데이터는 여기서 조회만 하고 저장은 안 한다.
 */
export default async function ImportedLookupPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <InboundTabs />

      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>수입육 이력 조회</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          수입일자를 넣으면 그날 수입된 목록을 받아옵니다. 박스에 적힌 유통식별번호(이력번호)와
          목록의 번호를 대조해 확인하세요. 조회 결과는 저장되지 않습니다.
        </p>
      </header>

      <ImportedLookupView />
    </div>
  );
}
