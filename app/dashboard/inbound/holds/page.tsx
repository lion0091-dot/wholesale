import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { InboundTabs } from "../../section-tabs";
import { HoldsView, type HoldItem, type RejectionItem } from "./holds-view";

export const metadata = {
  title: "보류함 | 도매업체 통합관리시스템",
};

interface ScanRow {
  id: string;
  trace_no: string;
  weight: number;
  po_state: string;
  created_at: string;
  product_id: string | null;
  supplier_id: string | null;
  products: { name: string } | { name: string }[] | null;
  suppliers: { name: string } | { name: string }[] | null;
}

interface RejectionRow {
  id: string;
  trace_no: string;
  weight: number;
  reason: string;
  created_at: string;
  supplier_id: string;
  product_id: string | null;
  products: { name: string } | { name: string }[] | null;
  suppliers: { name: string } | { name: string }[] | null;
}

function oneName(value: ScanRow["products"] | RejectionRow["products"]): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0]?.name ?? null : value.name ?? null;
}

/** 발주서에 없거나(UNLISTED_HELD) 초과로 받은(OVER_HELD) 박스 — 재고엔 이미 들어갔고 사무실이 확인할 차례. */
export default async function InboundHoldsPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const canManage = Boolean(
    scope &&
      (scope.isSuperAdmin ||
        scope.orgRole === "owner" ||
        scope.orgRole === "manager" ||
        (!scope.organizationId && scope.wholesalerId))
  );

  let holds: HoldItem[] = [];
  let rejections: RejectionItem[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const { data: scanRows } = await supabase
      .from("inbound_scans")
      .select("id, trace_no, weight, po_state, created_at, product_id, supplier_id, products(name), suppliers(name)")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("status", "NORMAL")
      .in("po_state", ["UNLISTED_HELD", "OVER_HELD"])
      .order("created_at", { ascending: false })
      .limit(100);

    const scans = (scanRows ?? []) as unknown as ScanRow[];
    const scanIds = scans.map((row) => row.id);

    const { data: fillRows } =
      scanIds.length > 0
        ? await supabase.from("purchase_order_line_scans").select("scan_id, weight").in("scan_id", scanIds)
        : { data: [] as Array<{ scan_id: string; weight: number | string }> };

    const assignedByScanId = new Map<string, number>();

    (fillRows ?? []).forEach((row) => {
      const key = String(row.scan_id);

      assignedByScanId.set(key, (assignedByScanId.get(key) ?? 0) + Number(row.weight));
    });

    holds = scans.map((row) => ({
      scanId: row.id,
      traceNo: row.trace_no,
      weight: Number(row.weight),
      poState: row.po_state as "UNLISTED_HELD" | "OVER_HELD",
      createdAt: row.created_at,
      productId: row.product_id,
      productName: oneName(row.products),
      supplierId: row.supplier_id,
      supplierName: oneName(row.suppliers),
      unassignedWeight: Number(row.weight) - (assignedByScanId.get(row.id) ?? 0),
    }));

    const { data: rejectionRows } = await supabase
      .from("inbound_rejections")
      .select("id, trace_no, weight, reason, created_at, supplier_id, product_id, products(name), suppliers(name)")
      .eq("wholesaler_id", scope.wholesalerId)
      .order("created_at", { ascending: false })
      .limit(50);

    rejections = ((rejectionRows ?? []) as unknown as RejectionRow[]).map((row) => ({
      id: row.id,
      traceNo: row.trace_no,
      weight: Number(row.weight),
      reason: row.reason as "OVER" | "UNLISTED",
      createdAt: row.created_at,
      productName: oneName(row.products),
      supplierName: oneName(row.suppliers),
    }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <InboundTabs />

      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>보류함</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          발주서에 없거나 발주 수량보다 많이 온 물건입니다. 이미 재고에 들어가 팔 수 있습니다 — 발주서를 사후에
          만들어 정리하려면 아래에서 &quot;발주서 추가 생성&quot;을 누르세요.
        </p>
      </header>

      <HoldsView holds={holds} rejections={rejections} canManage={canManage} />
    </div>
  );
}
