import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { InboundTabs } from "../../section-tabs";
import { StatementsView, type StatementFileItem, type SupplierOption } from "./statements-view";

export const metadata = {
  title: "명세서 보관 | 도매업체 통합관리시스템",
};

interface StatementRow {
  id: string;
  statement_date: string | null;
  memo: string | null;
  file_name: string;
  size_bytes: number | null;
  created_at: string;
  suppliers: { name: string } | { name: string }[] | null;
}

/** 공급처가 준 명세서 원본을 종류 상관없이 보관만 한다 — 내용은 읽지 않고 재고·매입에 반영되지 않는다. */
export default async function StatementsPage() {
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

  let files: StatementFileItem[] = [];
  let suppliers: SupplierOption[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: supplierRows }, { data: fileRows }] = await Promise.all([
      supabase
        .from("suppliers")
        .select("id, name")
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("supplier_statement_files")
        .select("id, statement_date, memo, file_name, size_bytes, created_at, suppliers(name)")
        .eq("wholesaler_id", scope.wholesalerId)
        .is("hidden_at", null)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    suppliers = (supplierRows ?? []).map((row) => ({ id: row.id as string, name: row.name as string }));

    files = ((fileRows ?? []) as unknown as StatementRow[]).map((row) => {
      const supplier = Array.isArray(row.suppliers) ? row.suppliers[0] : row.suppliers;

      return {
        id: row.id,
        statementDate: row.statement_date,
        memo: row.memo,
        fileName: row.file_name,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at,
        supplierName: supplier?.name ?? null,
      };
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <InboundTabs />

      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>명세서 보관</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0", lineHeight: 1.7 }}>
          공급처에서 받은 거래명세서를 엑셀·PDF·사진 등 어떤 형태든 그대로 올려 보관합니다. 파일 내용은
          읽지 않으며 재고·매입금액에는 반영되지 않습니다.
        </p>
      </header>

      <StatementsView
        wholesalerId={scope?.wholesalerId ?? null}
        files={files}
        suppliers={suppliers}
        canManage={canManage}
      />
    </div>
  );
}
