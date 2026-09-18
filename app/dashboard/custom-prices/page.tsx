import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { listCustomPrices } from "@/app/actions/custom_price";
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
import {
  SecretDealVisibilityManager,
  type SecretDealAssignment,
} from "./secret-deal-visibility-manager";

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

export default async function CustomPricesPage({ searchParams }: CustomPricesPageProps) {
  const { retailer: requestedRetailerId } = await searchParams;
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let customers: CustomerOption[] = [];
  let products: ProductOption[] = [];
  let assigned: AssignedCustomPrice[] = [];
  let secretDealAssignments: SecretDealAssignment[] = [];
  let isDemoData = true;

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: relations }, { data: productRows }, customPriceResult, { data: secretVisibilityRows }] =
      await Promise.all([
        supabase
          .from("wholesaler_retailers")
          .select("retailer_id, retailers ( restaurant_name )")
          .eq("wholesaler_id", scope.wholesalerId)
          .eq("status", "active"),
        supabase
          .from("products")
          .select("id, name, base_price, unit, is_secret_deal")
          .eq("wholesaler_id", scope.wholesalerId)
          .order("name", { ascending: true }),
        listCustomPrices(),
        supabase
          .from("secret_deal_visibility")
          .select("id, product_id, retailer_id")
          .eq("wholesaler_id", scope.wholesalerId),
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
      is_secret_deal: row.is_secret_deal,
    }));

    if (customers.length > 0 && products.length > 0) {
      isDemoData = false;

      const productMap = new Map(products.map((product) => [product.id, product]));
      const customerMap = new Map(customers.map((customer) => [customer.id, customer]));

      assigned = (customPriceResult.success ? customPriceResult.data ?? [] : []).map((row) => ({
        id: row.id,
        retailerId: row.retailer_id,
        retailerName: customerMap.get(row.retailer_id)?.name ?? "거래 종료된 고객(소매)",
        productId: row.product_id,
        productName: productMap.get(row.product_id)?.name ?? "삭제된 상품",
        basePrice: productMap.get(row.product_id)?.base_price ?? 0,
        unit: productMap.get(row.product_id)?.unit ?? "kg",
        customPrice: Number(row.custom_price),
        updatedAt: row.updated_at,
      }));

      secretDealAssignments = (secretVisibilityRows ?? []).map((row) => ({
        id: row.id as string,
        productId: row.product_id as string,
        productName: productMap.get(row.product_id as string)?.name ?? "삭제된 상품",
        retailerId: row.retailer_id as string,
        retailerName: customerMap.get(row.retailer_id as string)?.name ?? "거래 종료된 고객(소매)",
      }));
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
      is_secret_deal: product.is_secret_deal,
    }));
    assigned = DEMO_CUSTOM_PRICES.map((row) => {
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
        updatedAt: row.updated_at,
      };
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>맞춤 단가 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          거래 중인 고객(소매)별 VIP 단가를 지정합니다. 지정하지 않은 상품은 기본 단가가
          적용되며, 단가는 해당 고객(소매)에게만 노출됩니다.
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
        customers={customers}
        products={products}
        assigned={assigned}
        readOnly={isDemoData}
        initialRetailerId={
          customers.some((customer) => customer.id === requestedRetailerId)
            ? requestedRetailerId
            : undefined
        }
      />

      <SecretDealVisibilityManager
        customers={customers}
        secretDealProducts={products.filter((product) => product.is_secret_deal)}
        assignments={secretDealAssignments}
        readOnly={isDemoData}
      />
    </div>
  );
}
