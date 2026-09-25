import { isSuperAdminWithoutScope, getSupplierScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { loadCustomPriceHistoryItems } from "../custom-price-history-loader";
import { HistoryPickerList } from "../history-picker-list";

export const metadata = {
  title: "맞춤단가 이력 | 도매업체 통합관리시스템",
};

export default async function CustomPriceHistoryPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const items = await loadCustomPriceHistoryItems();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>
        거래처+상품을 골라 맞춤단가 변경 이력을 확인합니다.
      </p>

      <HistoryPickerList
        tableName="custom_prices"
        items={items}
        searchPlaceholder="거래처명 또는 상품명으로 검색"
        emptyMessage="지정된 맞춤단가가 없습니다."
      />
    </div>
  );
}
