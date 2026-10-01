import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { InboundScanView } from "./inbound-scan-view";
import { loadInboundData } from "./inbound-data";
import { isMtraceConfigured, configuredTraceSources } from "@/lib/livestock/mtrace-client";
import { pickFieldNextStep } from "@/lib/livestock/inbound-next-step";
import { InboundNextStepCard } from "./inbound-next-step-card";
import { InboundTabs } from "../section-tabs";
import { InboundAutoRetry } from "./inbound-auto-retry";
import { InboundLiveRefresh } from "./inbound-live-refresh";
import { InboundImportPanel } from "./inbound-import-panel";

/** 이력 조회 기관 표기 — 설정 안내 문구에 쓴다. */
const SOURCE_LABELS: Record<string, string> = {
  mtrace: "국내산 소·돼지",
  meatwatch: "수입 축산물",
  poultry: "닭·오리·계란",
};

export const metadata = {
  title: "입고 스캔 | 도매업체 통합관리시스템",
};

/** 현장이 쓰는 입고 화면. */
export default async function InboundPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  // 서로 결과를 안 쓰는 조회 3개(입고 데이터·거래처 목록·부위 옵션)를 병렬로 묶는다.
  const supabase = await createClient();

  const [data, supplierRows, partRows] = await Promise.all([
    loadInboundData(scope),
    scope?.wholesalerId
      ? supabase
          .from("suppliers")
          .select("id, name")
          .eq("wholesaler_id", scope.wholesalerId)
          .eq("is_active", true)
          .order("name", { ascending: true })
          .then((result) => result.data)
      : Promise.resolve(null),
    // 부위 드롭박스 목록(마이그레이션 176~179): 현장에서 부위를 새로 만들지 않고 이미 등록된 부위에서만 고른다.
    // 그 거래처의 열린 전표(발주서)에 있는 부위를 먼저, 전표가 없으면 이 업체에 등록된 상품의 부위 전체를 쓴다.
    // 전 행을 읽어 화면에서 거르면 PostgREST 1000행 상한에 부위가 잘리므로 DB가 DISTINCT로 돌려준다.
    scope?.wholesalerId
      ? supabase.rpc("inbound_part_options").then((result) => result.data)
      : Promise.resolve(null),
  ]);

  const configured = configuredTraceSources();

  // "지금 온 거래처"로 고를 수 있는 거래처(발주 관리의 거래처 관리에서 만든 사용 중인 것).
  const suppliers: Array<{ id: string; name: string }> = scope?.wholesalerId
    ? ((supplierRows ?? []) as Array<{ id: string; name: string }>)
    : [];

  let partOptions: { byPo: Record<string, string[]>; all: string[] } = { byPo: {}, all: [] };

  if (scope?.wholesalerId) {
    const byPo: Record<string, string[]> = {};
    const all: string[] = [];

    for (const row of (partRows ?? []) as Array<{ supplier_id: string | null; part: string }>) {
      if (row.supplier_id) (byPo[row.supplier_id] ??= []).push(row.part);
      else all.push(row.part);
    }

    for (const list of Object.values(byPo)) list.sort((a, b) => a.localeCompare(b, "ko"));
    all.sort((a, b) => a.localeCompare(b, "ko"));

    partOptions = { byPo, all };
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <InboundTabs />
      <InboundAutoRetry />
      {scope?.wholesalerId && <InboundLiveRefresh wholesalerId={scope.wholesalerId} />}

      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>입고 스캔</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          바코드를 찍고 저울에 잰 <strong>실중량</strong>을 넣으면 재고에 들어갑니다.
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
          되지 않아 “확인 필요”로 쌓입니다. 키를 등록하면 시스템이 자동으로 다시 조회해 채웁니다.
        </div>
      ) : (
        <div style={{ fontSize: "12px", color: "#64748b" }}>
          이력 조회 가능: {configured.map((source) => SOURCE_LABELS[source] ?? source).join(" · ")}
        </div>
      )}

      <InboundNextStepCard step={pickFieldNextStep(data.nextStepInput)} />

      <InboundScanView
        initialScans={data.scans}
        products={data.products}
        shippableOrders={data.shippableOrders}
        scanRequirements={data.scanRequirements}
        storageLocationSuggestions={data.storageLocationSuggestions}
        archivedProductCount={data.archivedProductCount}
        canEditPurchasePrice={data.canManage}
        suppliers={suppliers}
        partOptions={partOptions}
      />

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
