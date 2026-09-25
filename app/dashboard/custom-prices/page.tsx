import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { listCustomPrices, type CustomPriceRow } from "@/app/actions/custom_price";
import {
  CustomPriceManager,
  type AssignedCustomPrice,
  type CustomerOption,
  type ProductOption,
} from "./custom-price-manager";
import { CustomerTabs } from "../section-tabs";

export const metadata = {
  title: "맞춤 단가 관리 | 도매업체 통합관리시스템",
};

/** wholesaler_retailers + retailers 조인 응답 형태 */
interface RelationRow {
  retailer_id: string;
  retailers: { restaurant_name: string } | { restaurant_name: string }[] | null;
}

function relationName(row: RelationRow): string {
  const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;

  return retailer?.restaurant_name ?? "이름 미등록 고객(소매)";
}

interface CustomPricesPageProps {
  /** 고객 관리 카드에서 넘어올 때 선택될 바이어 (?retailer=<retailer_id>) */
  searchParams: Promise<{ retailer?: string }>;
}

function toAssigned(
  rows: CustomPriceRow[],
  productMap: Map<string, ProductOption>,
  customerMap: Map<string, CustomerOption>
): AssignedCustomPrice[] {
  return rows.map((row) => ({
    id: row.id,
    retailerId: row.retailer_id,
    retailerName: customerMap.get(row.retailer_id)?.name ?? "거래 종료된 고객(소매)",
    productId: row.product_id,
    productName: productMap.get(row.product_id)?.name ?? "삭제된 상품",
    basePrice: productMap.get(row.product_id)?.base_price ?? 0,
    unit: productMap.get(row.product_id)?.unit ?? "kg",
    customPrice: Number(row.custom_price),
    isActive: row.is_active,
    updatedAt: row.updated_at,
  }));
}

export default async function CustomPricesPage({ searchParams }: CustomPricesPageProps) {
  const { retailer: requestedRetailerId } = await searchParams;
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let customers: CustomerOption[] = [];
  let products: ProductOption[] = [];
  let customAssigned: AssignedCustomPrice[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: relations }, { data: productRows }, customPriceResult] = await Promise.all([
      supabase
        .from("wholesaler_retailers")
        .select("retailer_id, retailers ( restaurant_name )")
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("status", "active"),
      supabase
        .from("products")
        .select("id, name, base_price, unit")
        .eq("wholesaler_id", scope.wholesalerId)
        .order("name", { ascending: true }),
      listCustomPrices(),
    ]);

    customers = ((relations ?? []) as RelationRow[]).map((row) => ({
      id: row.retailer_id,
      name: relationName(row),
    }));

    products = ((productRows ?? []) as ProductOption[]).map((row) => ({
      id: row.id,
      name: row.name,
      base_price: Number(row.base_price),
      unit: row.unit,
    }));

    const productMap = new Map(products.map((product) => [product.id, product]));
    const customerMap = new Map(customers.map((customer) => [customer.id, customer]));
    const allRows = customPriceResult.success ? customPriceResult.data ?? [] : [];

    customAssigned = toAssigned(allRows, productMap, customerMap);
  }

  const initialRetailerId = customers.some((customer) => customer.id === requestedRetailerId)
    ? requestedRetailerId
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <CustomerTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>맞춤 단가 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          거래 중인 고객(소매)별로 맞춤 단가를 지정합니다. 지정하지 않은 상품은 기본 단가가
          적용되며, 지정한 단가는 그 고객(소매)에게만 노출됩니다. 핫딜(전체 공개 특가)은
          상품 등록/수정 화면에서 켭니다.
        </p>
      </header>

      <CustomPriceManager
        title="맞춤 단가"
        description="우수 단골 고객에게 조용히 적용하는 표준 할인가입니다."
        customers={customers}
        products={products}
        assigned={customAssigned}
        initialRetailerId={initialRetailerId}
      />
    </div>
  );
}
