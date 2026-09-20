import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { listCustomPrices, type CustomPriceRow } from "@/app/actions/custom_price";
import {
  DEMO_CUSTOM_PRICES,
  DEMO_PRODUCTS,
  DEMO_RETAILERS,
} from "@/lib/demo/supplier-samples";
import {
  CustomPriceManager,
  type AssignedCustomPrice,
  type CustomerOption,
  type ProductOption,
} from "./custom-price-manager";

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
  let hotDealAssigned: AssignedCustomPrice[] = [];
  let isDemoData = true;

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

    if (customers.length > 0 && products.length > 0) {
      isDemoData = false;

      const productMap = new Map(products.map((product) => [product.id, product]));
      const customerMap = new Map(customers.map((customer) => [customer.id, customer]));
      const allRows = customPriceResult.success ? customPriceResult.data ?? [] : [];

      customAssigned = toAssigned(
        allRows.filter((row) => row.kind === "custom"),
        productMap,
        customerMap
      );
      hotDealAssigned = toAssigned(
        allRows.filter((row) => row.kind === "hot_deal"),
        productMap,
        customerMap
      );
    }
  }

  if (isDemoData) {
    customers = DEMO_RETAILERS.map((retailer) => ({
      id: retailer.id,
      name: retailer.restaurant_name,
    }));
    products = DEMO_PRODUCTS.map((product) => ({
      id: product.id,
      name: product.name,
      base_price: Number(product.base_price),
      unit: product.unit,
    }));

    const demoAssigned = (kind: "custom" | "hot_deal"): AssignedCustomPrice[] =>
      DEMO_CUSTOM_PRICES.filter((row) => row.kind === kind).map((row) => {
        const product = DEMO_PRODUCTS.find((item) => item.id === row.product_id);

        return {
          id: row.id,
          retailerId: row.retailer_id,
          retailerName:
            DEMO_RETAILERS.find((item) => item.id === row.retailer_id)?.restaurant_name ?? "-",
          productId: row.product_id,
          productName: product?.name ?? "-",
          basePrice: Number(product?.base_price ?? 0),
          unit: product?.unit ?? "kg",
          customPrice: row.custom_price,
          isActive: row.is_active,
          updatedAt: row.updated_at,
        };
      });

    customAssigned = demoAssigned("custom");
    hotDealAssigned = demoAssigned("hot_deal");
  }

  const initialRetailerId = customers.some((customer) => customer.id === requestedRetailerId)
    ? requestedRetailerId
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>맞춤 단가 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          거래 중인 고객(소매)별로 맞춤 단가·핫딜을 지정합니다. 지정하지 않은 상품은 기본 단가가
          적용되며, 지정한 단가는 그 고객(소매)에게만 노출됩니다.
        </p>
      </header>

      {isDemoData && (
        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
          }}
        >
          ℹ️ 거래 중인 고객(소매) 또는 등록된 상품이 없어 샘플 데이터로 화면을 표시합니다. 샘플
          데이터는 저장/삭제되지 않습니다.
        </div>
      )}

      <CustomPriceManager
        kind="custom"
        title="맞춤 단가"
        description="우수 단골 고객에게 조용히 적용하는 표준 할인가입니다."
        customers={customers}
        products={products}
        assigned={customAssigned}
        readOnly={isDemoData}
        initialRetailerId={initialRetailerId}
      />

      <CustomPriceManager
        kind="hot_deal"
        title="핫딜"
        description="재고처분 등 한정 수량 특가입니다. 고객별로 껐다 켰다 할 수 있어 소진되면 끄고, 재입고되면 다시 켜면 됩니다."
        customers={customers}
        products={products}
        assigned={hotDealAssigned}
        readOnly={isDemoData}
        initialRetailerId={initialRetailerId}
      />
    </div>
  );
}
