import { createClient } from "@/lib/supabase/server";
import { resolveCostAccess } from "@/lib/supplier/cost-access";
import type { getSupplierScope } from "@/lib/supplier/scope";
import type { InboundScanRow, ScanProductOption, ShippableOrderOption } from "./inbound-scan-view";
import {
  buildScanRequirementReport,
  resolveTraceOrigin,
  type ScanRequirementReport,
} from "@/lib/livestock/inbound-requirements";
import type { InboundNextStepInput } from "@/lib/livestock/inbound-next-step";

type SupplierScope = Awaited<ReturnType<typeof getSupplierScope>>;

export interface InboundData {
  scans: InboundScanRow[];
  products: ScanProductOption[];
  shippableOrders: ShippableOrderOption[];
  scanRequirements: Record<string, ScanRequirementReport>;
  storageLocationSuggestions: string[];
  /** 보관(감춤) 처리돼 상품 지정 목록에서 빠진 상품 수 — 목록이 비었을 때 "상품이 없다"고만 말하지 않고 보관을 풀라고 안내하는 데 쓴다. */
  archivedProductCount: number;
  /** 안내 카드가 받는 입력. */
  nextStepInput: InboundNextStepInput;
  /** 원가(매입단가·금액)를 보고 입력할 수 있는 사람 — 대표 + 전표 담당 직원(마이그레이션 209). */
  canViewCost: boolean;
}

/** 입고 스캔(현장) 화면이 쓰는 조회. */
export async function loadInboundData(scope: SupplierScope): Promise<InboundData> {
  let scans: InboundScanRow[] = [];
  let products: ScanProductOption[] = [];
  let shippableOrders: ShippableOrderOption[] = [];
  let scanRequirements: Record<string, ScanRequirementReport> = {};
  // 창고 구조가 업체마다 달라(플랫폼) 고정 위치 목록 대신, 이 업체가 그동안
  // 직접 입력한 위치 이름을 제안 목록으로 쓴다.
  let storageLocationSuggestions: string[] = [];
  let archivedProductCount = 0;
  let canViewCost = false;

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    // 입고 내역은 계속 쌓이기만 하므로 최근 100건만 불러온다. 현장에서 보는 건
    // "방금 찍은 것들"이고, 과거 조회는 이력관리 메뉴가 따로 담당한다.
    // 주문 목록은 출고 스캔 화면(app/dashboard/outbound/page.tsx)과 같은 기준
    // (확정·배송중만)이다 — "이 박스 특정 주문으로 바로 보내기"가 결국 출고 스캔을
    // 대신 호출하므로 같은 상태만 배정 대상이어야 한다.
    const [{ data: recentScanRows }, { data: openScanRows }, { data: productRows }, { data: orderRows }] =
      await Promise.all([
        supabase
          .from("inbound_scans")
          .select(
            "id, trace_no, product_id, supplier_id, weight, unit, scan_type, status, remaining_weight, created_at, labeled_weight, weight_variance, purchase_supplier, scanned_by, storage_location, storage_location_photo_path"
          )
          .eq("wholesaler_id", scope.wholesalerId)
          .order("created_at", { ascending: false })
          .limit(100),
        // 확인이 필요한 박스(이력 못 찾음·상품 미확정)는 최근 100건 밖으로 밀려나도 화면에 남겨야 한다 —
        // 종 배지는 전부 세는데 여기서만 빠지면 "확인 필요 1"인데 찾을 수 없는 박스가 된다.
        supabase
          .from("inbound_scans")
          .select(
            "id, trace_no, product_id, supplier_id, weight, unit, scan_type, status, remaining_weight, created_at, labeled_weight, weight_variance, purchase_supplier, scanned_by, storage_location, storage_location_photo_path"
          )
          .eq("wholesaler_id", scope.wholesalerId)
          .in("status", ["EXCEPTION", "PENDING_MAPPING"])
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("products")
          .select("id, name, category, subcategory, grade, origin, unit, is_active")
          .eq("wholesaler_id", scope.wholesalerId)
          // 판매중지 상품도 넣는다 — 입고 때 자동으로 만들어지는 상품은 항상 판매중지라, 빼면 상품 지정 목록에서 영영 안 보인다.
          // 보관(감춘) 상품만 뺀다.
          .is("archived_at", null)
          .order("name", { ascending: true }),
        supabase
          .from("orders")
          .select("id, order_number, retailers ( restaurant_name )")
          .eq("wholesaler_id", scope.wholesalerId)
          .in("status", ["awaiting_stock", "confirmed", "shipping"])
          .order("ordered_at", { ascending: true })
          .limit(50),
      ]);

    // 카드 버튼이 #scan-<id>로 이동하므로, 화면에 실제로 그려진(최근 100건) 박스만 후보로 삼는다.
    const scanRows = [
      ...new Map(
        [...((recentScanRows ?? []) as Array<Record<string, unknown>>), ...((openScanRows ?? []) as Array<Record<string, unknown>>)].map((row) => [String(row.id), row])
      ).values(),
    ].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));

    // 원가 컬럼은 직접 조회가 막혀 있어(209) 대표·전표 담당만 get_scan_costs로 읽는다. 다른 사람에겐 금액을 아예 안 가져온다.
    canViewCost = await resolveCostAccess(supabase, scope);

    const costByScan = new Map<string, { unitPrice: number | null; amount: number | null }>();

    if (canViewCost && scanRows.length > 0) {
      const { data: costRows } = await supabase.rpc("get_scan_costs", {
        p_scan_ids: scanRows.map((row) => String(row.id)),
      });

      ((costRows ?? []) as Array<{ scan_id: string; unit_price: number | string | null; amount: number | string | null }>).forEach((row) => {
        costByScan.set(row.scan_id, {
          unitPrice: row.unit_price === null ? null : Number(row.unit_price),
          amount: row.amount === null ? null : Number(row.amount),
        });
      });
    }

    products = (productRows ?? []) as ScanProductOption[];

    if (products.length === 0) {
      const { count } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("wholesaler_id", scope.wholesalerId)
        .not("archived_at", "is", null);

      archivedProductCount = count ?? 0;
    }

    shippableOrders = ((orderRows ?? []) as Array<Record<string, unknown>>).map((row) => {
      const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;

      return {
        id: String(row.id),
        orderNumber: String(row.order_number),
        retailerName:
          ((retailer as Record<string, unknown> | null)?.restaurant_name as string | null) ?? "거래처",
      };
    });

    const productNames = new Map(products.map((product) => [product.id, product.name]));
    const productOrigins = new Map(products.map((product) => [product.id, product.origin]));

    // 스캔한 박스마다 "필수 항목이 다 찼는지"를 보여주려면 값이 들어오는 길을
    // 다 봐야 한다 — 스캔 자체, 공공 이력조회(master_livestock). 화면에서 줄마다
    // 조회하면 N+1이라 이력번호를 모아 한 번씩만 읽는다.
    const traceNos = [...new Set((scanRows ?? []).map((row) => String(row.trace_no)))];

    let masterByTrace = new Map<
      string,
      { grade: string | null; origin: string | null; species: string | null }
    >();

    if (traceNos.length > 0) {
      const { data: masterRows } = await supabase
        .from("master_livestock")
        .select("trace_no, grade, origin_country, source, species_group")
        .in("trace_no", traceNos);

      masterByTrace = new Map(
        ((masterRows ?? []) as Array<Record<string, unknown>>).map((row) => [
          String(row.trace_no),
          {
            grade: (row.grade as string | null) ?? null,
            origin: resolveTraceOrigin(
              row.source as string | null,
              row.origin_country as string | null
            ),
            species: (row.species_group as string | null) ?? null,
          },
        ])
      );
    }

    scanRequirements = Object.fromEntries(
      ((scanRows ?? []) as Array<Record<string, unknown>>).map((row) => {
        const traceNo = String(row.trace_no);
        const master = masterByTrace.get(traceNo);
        const productId = (row.product_id as string | null) ?? null;

        return [
          String(row.id),
          buildScanRequirementReport({
            traceNo,
            productId,
            productName: productId ? productNames.get(productId) ?? null : null,
            productOrigin: productId ? productOrigins.get(productId) ?? null : null,
            weight: row.weight === null ? null : Number(row.weight),
            labeledWeight: row.labeled_weight === null ? null : Number(row.labeled_weight),
            purchaseUnitPrice: costByScan.get(String(row.id))?.unitPrice ?? null,
            showUnitPrice: canViewCost,
            purchaseSupplier: (row.purchase_supplier as string | null) ?? null,
            traceFound: Boolean(master),
            apiSpecies: master?.species ?? null,
            apiGrade: master?.grade ?? null,
            apiOrigin: master?.origin ?? null,
          }),
        ];
      })
    );

    // 여러 직원이 같은 화면을 섞어서 쓰므로 누가 찍었는지 목록에서 바로 보여준다
    // (list_stock_ledger()의 actor_name과 같은 목적). 줄마다 조회하면 N+1이라
    // scanned_by를 모아 한 번만 읽는다.
    const scannedByIds = [
      ...new Set(
        ((scanRows ?? []) as Array<Record<string, unknown>>)
          .map((row) => row.scanned_by as string | null)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    const scannerNameById = new Map<string, string>();

    if (scannedByIds.length > 0) {
      // profiles를 직접 조회하면 RLS(본인 행 또는 super_admin만 SELECT 가능)에 막혀
      // 본인 이름만 보인다 — 여러 직원이 섞여 찍는 화면이라 남의 이름도 봐야 한다.
      // list_wholesaler_member_names()는 이 조회를 위해 이미 있는 SECURITY DEFINER RPC다.
      const { data: memberNames } = await supabase.rpc("list_wholesaler_member_names", {
        p_wholesaler_id: scope.wholesalerId,
      });

      ((memberNames ?? []) as Array<{ user_id: string; name: string | null }>).forEach((member) => {
        if (member.name) {
          scannerNameById.set(member.user_id, member.name);
        }
      });
    }

    scans = ((scanRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      traceNo: String(row.trace_no),
      productId: (row.product_id as string | null) ?? null,
      productName: row.product_id ? productNames.get(String(row.product_id)) ?? null : null,
      weight: Number(row.weight),
      unit: String(row.unit),
      scanType: String(row.scan_type),
      status: String(row.status) as InboundScanRow["status"],
      remainingWeight: Number(row.remaining_weight),
      createdAt: String(row.created_at),
      labeledWeight: row.labeled_weight === null ? null : Number(row.labeled_weight),
      weightVariance: row.weight_variance === null ? null : Number(row.weight_variance),
      purchaseUnitPrice: costByScan.get(String(row.id))?.unitPrice ?? null,
      purchaseAmount: costByScan.get(String(row.id))?.amount ?? null,
      purchaseSupplier: (row.purchase_supplier as string | null) ?? null,
      scannedByName: row.scanned_by ? (scannerNameById.get(String(row.scanned_by)) ?? "직원") : null,
      storageLocation: (row.storage_location as string | null) ?? null,
      storageLocationPhotoPath: (row.storage_location_photo_path as string | null) ?? null,
    }));

    // 상품 확인이 필요한 박스: 지금 거래처의 열린 발주서 중 맞는 상품 후보(마이그레이션 175)를 붙인다.
    // 후보가 있으면 화면이 전체 상품 목록 대신 후보 버튼을 보여 준다. 대기 박스는 적어서 박스마다 한 번씩 부른다(최대 20개).
    // 거래처가 없는 박스(엑셀 대량 입고 등)는 전표 후보 계산이 의미 없어 함수를 부르지 않는다 — 화면을 열 때마다 도는 호출이라 아낀다.
    const supplierByScan = new Map(((scanRows ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.id), (row.supplier_id as string | null) ?? null]));
    const pendingScans = scans.filter((scan) => scan.status === "PENDING_MAPPING").slice(0, 20);

    await Promise.all(
      pendingScans.map(async (scan) => {
        if (supplierByScan.get(scan.id)) {
          const { data: candidates } = await supabase.rpc("scan_po_candidates", { p_scan_id: scan.id });
          const choices = ((candidates ?? []) as Array<{ product_id: string; name: string }>).map((item) => ({
            productId: item.product_id,
            name: item.name,
          }));

          if (choices.length > 0) {
            scan.productChoices = choices;
            return;
          }

          // 후보가 하나도 없으면 그 거래처의 열린 발주서 상품 전체를 보여 준다(마이그레이션 177).
          const { data: poProducts } = await supabase.rpc("scan_open_po_products", { p_scan_id: scan.id });
          const list = ((poProducts ?? []) as Array<{ product_id: string; name: string }>).map((item) => ({
            productId: item.product_id,
            name: item.name,
          }));

          if (list.length > 0) {
            scan.poProducts = list;
            return;
          }
        }

        // 전표로도 못 정했고(또는 거래처가 없고) 냉장/냉동이 의미 있는 축종이면 냉장/냉동을 사람이 고르게 한다(마이그레이션 178).
        const species = masterByTrace.get(scan.traceNo)?.species ?? null;

        if (species && ["소", "돼지", "닭", "오리"].includes(species)) scan.needsStorage = true;
      })
    );

    // 업체마다 창고 구조가 달라 고정 목록을 안 두고, 그동안 이 업체가 직접
    // 입력했던 위치 이름을 골라 쓸 수 있게 제안한다(플랫폼 여러 업체 대응).
    storageLocationSuggestions = [
      ...new Set(
        scans
          .map((scan) => scan.storageLocation)
          .filter((value): value is string => Boolean(value))
      ),
    ].sort((a, b) => a.localeCompare(b, "ko"));
  }

  const nextStepInput: InboundNextStepInput = {
    needsCheckScanCount: scans.filter(
      (scan) => scan.status === "EXCEPTION" || scan.status === "PENDING_MAPPING"
    ).length,
    firstNeedsCheckScanId:
      scans.find((scan) => scan.status === "EXCEPTION" || scan.status === "PENDING_MAPPING")?.id ?? null,
  };

  return {
    scans,
    products,
    shippableOrders,
    scanRequirements,
    storageLocationSuggestions,
    archivedProductCount,
    nextStepInput,
    canViewCost,
  };
}
