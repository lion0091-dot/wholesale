import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import {
  InboundScanView,
  type InboundScanRow,
  type ScanProductOption,
  type ShippableOrderOption,
  type AwaitingDocumentLine,
} from "./inbound-scan-view";
import { InboundImportPanel } from "./inbound-import-panel";
import { InboundDocumentPanel, type InboundDocumentRow } from "./inbound-document-panel";
import { isMtraceConfigured, configuredTraceSources } from "@/lib/livestock/mtrace-client";
import {
  buildScanRequirementReport,
  resolveTraceOrigin,
  type ScanRequirementReport,
} from "@/lib/livestock/inbound-requirements";
import { documentLineExpectedQty, documentLineMatchStatus } from "@/lib/livestock/document-reconciliation";
import { pickInboundNextStep } from "@/lib/livestock/inbound-next-step";
import { InboundNextStepCard } from "./inbound-next-step-card";

/** 이력 조회 기관 표기 — 설정 안내 문구에 쓴다. */
const SOURCE_LABELS: Record<string, string> = {
  mtrace: "국내산 소·돼지",
  meatwatch: "수입 축산물",
  poultry: "닭·오리·계란",
};

export const metadata = {
  title: "입고 스캔 | 도매업체 통합관리시스템",
};

export default async function InboundPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let scans: InboundScanRow[] = [];
  let products: ScanProductOption[] = [];
  let shippableOrders: ShippableOrderOption[] = [];
  let documents: InboundDocumentRow[] = [];
  let scanRequirements: Record<string, ScanRequirementReport> = {};
  // "박스 나눠서 입고"에서 줄마다 적은(또는 박스 코드를 그대로 재사용한) 이력번호가
  // 올려둔 명세서에 실제로 있는 번호인지 대조하는 배너용 — 대기중(PENDING) 명세서
  // 줄에 적힌 번호만 모은다. 명세서 자체가 없으면 대조할 게 없으니 조용히 넘어간다.
  let pendingDocumentTraceNos: string[] = [];
  // 명세서엔 있는데 아직 스캔 안 된 줄 — "명세서 대기 품목" 목록(탭하면 이력번호
  // 입력칸을 채워줌)에 쓴다. 최근 100건짜리 scans 배열로 대조하면 오래된 명세서
  // 건이 그 창밖으로 밀려나 잘못 "아직 안 들어옴"으로 보일 수 있어, 이 줄들의
  // 이력번호만 따로 모아 inbound_scans 전체에서 존재 여부를 확인한다.
  let awaitingDocumentLines: AwaitingDocumentLine[] = [];
  // 창고 구조가 업체마다 달라(플랫폼) 고정 위치 목록 대신, 이 업체가 그동안
  // 직접 입력한 위치 이름을 제안 목록으로 쓴다.
  let storageLocationSuggestions: string[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    // 입고 내역은 계속 쌓이기만 하므로 최근 100건만 불러온다. 현장에서 보는 건
    // "방금 찍은 것들"이고, 과거 조회는 이력관리 메뉴가 따로 담당한다.
    // 주문 목록은 출고 스캔 화면(app/dashboard/outbound/page.tsx)과 같은 기준
    // (확정·배송중만)이다 — "이 박스 특정 주문으로 바로 보내기"가 결국 출고 스캔을
    // 대신 호출하므로 같은 상태만 배정 대상이어야 한다.
    const [{ data: scanRows }, { data: productRows }, { data: orderRows }, { data: pendingDocLineRows }] =
      await Promise.all([
        supabase
          .from("inbound_scans")
          .select(
            "id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight, created_at, labeled_weight, weight_variance, purchase_unit_price, purchase_amount, purchase_supplier, scanned_by, storage_location, storage_location_photo_path"
          )
          .eq("wholesaler_id", scope.wholesalerId)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("products")
          .select("id, name, category, subcategory, grade, origin, unit")
          .eq("wholesaler_id", scope.wholesalerId)
          .eq("is_active", true)
          .order("name", { ascending: true }),
        supabase
          .from("orders")
          .select("id, order_number, retailers ( restaurant_name )")
          .eq("wholesaler_id", scope.wholesalerId)
          .in("status", ["awaiting_stock", "confirmed", "shipping"])
          .order("ordered_at", { ascending: true })
          .limit(50),
        supabase
          .from("inbound_document_lines")
          .select(
            "id, trace_no, lot_no, item_name, labeled_weight, unit_price, inbound_documents!inner(status, supplier_name)"
          )
          .eq("inbound_documents.status", "PENDING")
          .or("trace_no.not.is.null,lot_no.not.is.null"),
      ]);

    pendingDocumentTraceNos = [
      ...new Set(
        ((pendingDocLineRows ?? []) as Array<{ trace_no: string | null; lot_no: string | null }>)
          .flatMap((row) => [row.trace_no, row.lot_no])
          .map((value) => (value ?? "").trim().toUpperCase())
          .filter((value) => value.length > 0)
      ),
    ];

    if (pendingDocumentTraceNos.length > 0) {
      // "아직 안 만난 줄" 판정은 DB가 한다 — 같은 번호뿐 아니라 명세서는 로트·박스는 개체번호(또는 반대)인
      // 경우도 로트 구성원 목록(master_livestock.raw_payload)으로 이어 본다(마이그레이션 116).
      const { data: awaitingIdRows } = await supabase.rpc("list_awaiting_document_line_ids", {
        p_wholesaler_id: scope.wholesalerId,
      });
      const awaitingIds = new Set(((awaitingIdRows ?? []) as string[]).map(String));

      awaitingDocumentLines = ((pendingDocLineRows ?? []) as Array<Record<string, unknown>>)
        .filter((row) => awaitingIds.has(String(row.id)))
        .map((row) => {
          const document = Array.isArray(row.inbound_documents)
            ? row.inbound_documents[0]
            : row.inbound_documents;

          return {
            id: String(row.id),
            // 탭하면 입력칸에 채울 번호 — 개체번호가 있으면 그것(더 구체적), 없으면 로트번호.
            traceNo: String(row.trace_no ?? row.lot_no),
            itemName: (row.item_name as string | null) ?? null,
            labeledWeight: row.labeled_weight === null ? null : Number(row.labeled_weight),
            unitPrice: row.unit_price === null ? null : Number(row.unit_price),
            supplierName:
              ((document as Record<string, unknown> | null)?.supplier_name as string | null) ?? null,
          };
        });
    }

    // 올린 명세서 목록. 저장만 되고 다시 열어볼 곳이 없으면 쓸모가 없어서 함께 내린다.
    // 줄 수는 행마다 세면 N+1이라 관계 count로 한 번에 받는다.
    const { data: documentRows } = await supabase
      .from("inbound_documents")
      .select(
        "id, supplier_name, document_no, issued_on, file_name, storage_path, status, total_amount, created_at, inbound_document_lines(count)"
      )
      .eq("wholesaler_id", scope.wholesalerId)
      .order("created_at", { ascending: false })
      .limit(30);

    // 대조 화면(29단계 B) 진입 배지용 — PENDING·CLOSED 문서만 줄 상태를 요약한다.
    // N개 문서마다 RPC를 부르지 않고 연결표를 한 번에 읽어 서버에서 센다(스펙 5번과 같은 원칙).
    const matchTargetDocIds = ((documentRows ?? []) as Array<Record<string, unknown>>)
      .filter((row) => row.status === "PENDING" || row.status === "CLOSED")
      .map((row) => String(row.id));

    const matchSummaryByDocId = new Map<string, { completeLines: number; totalLines: number }>();

    if (matchTargetDocIds.length > 0) {
      const { data: matchLineRows } = await supabase
        .from("inbound_document_lines")
        .select("id, document_id, quantity")
        .in("document_id", matchTargetDocIds);

      const matchLines = (matchLineRows ?? []) as Array<{ id: string; document_id: string; quantity: number | null }>;
      const matchLineIds = matchLines.map((row) => String(row.id));

      const { data: matchLinkRows } =
        matchLineIds.length > 0
          ? await supabase
              .from("inbound_document_line_scans")
              .select("line_id, inbound_scans(status)")
              .in("line_id", matchLineIds)
          : { data: [] as Array<Record<string, unknown>> };

      const linkedCountByLineId = new Map<string, number>();

      ((matchLinkRows ?? []) as Array<Record<string, unknown>>).forEach((row) => {
        const scan = row.inbound_scans as { status: string } | { status: string }[] | null;
        const scanStatus = Array.isArray(scan) ? scan[0]?.status : scan?.status;

        if (scanStatus === "VOIDED") return;

        const lineId = String(row.line_id);

        linkedCountByLineId.set(lineId, (linkedCountByLineId.get(lineId) ?? 0) + 1);
      });

      matchLines.forEach((line) => {
        const expected = documentLineExpectedQty(line.quantity === null ? null : Number(line.quantity));
        const linked = linkedCountByLineId.get(String(line.id)) ?? 0;
        const status = documentLineMatchStatus(expected, linked);
        const docId = String(line.document_id);
        const current = matchSummaryByDocId.get(docId) ?? { completeLines: 0, totalLines: 0 };

        current.totalLines += 1;
        if (status === "COMPLETE") current.completeLines += 1;
        matchSummaryByDocId.set(docId, current);
      });
    }

    documents = ((documentRows ?? []) as Array<Record<string, unknown>>).map((row) => {
      const counts = row.inbound_document_lines as Array<{ count: number }> | null;

      return {
        id: String(row.id),
        supplierName: (row.supplier_name as string | null) ?? null,
        documentNo: (row.document_no as string | null) ?? null,
        issuedOn: (row.issued_on as string | null) ?? null,
        fileName: (row.file_name as string | null) ?? null,
        hasFile: Boolean(row.storage_path),
        status: String(row.status),
        totalAmount: row.total_amount === null ? null : Number(row.total_amount),
        createdAt: String(row.created_at),
        lineCount: counts?.[0]?.count ?? 0,
        matchSummary: matchSummaryByDocId.get(String(row.id)) ?? null,
      };
    });

    products = (productRows ?? []) as ScanProductOption[];

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

    // 스캔한 박스마다 "필수 항목이 다 찼는지"를 보여주려면 값이 들어오는 세 길을
    // 다 봐야 한다 — 스캔 자체, 공공 이력조회(master_livestock), 올라온 명세서.
    // 화면에서 줄마다 조회하면 N+1이라 이력번호를 모아 한 번씩만 읽는다.
    const traceNos = [...new Set((scanRows ?? []).map((row) => String(row.trace_no)))];

    let masterByTrace = new Map<
      string,
      { grade: string | null; origin: string | null; species: string | null }
    >();
    let documentByTrace = new Map<
      string,
      {
        supplier: string | null;
        itemName: string | null;
        grade: string | null;
        origin: string | null;
        unitPrice: number | null;
        labeledWeight: number | null;
      }
    >();

    if (traceNos.length > 0) {
      const [{ data: masterRows }, { data: docLineRows }] = await Promise.all([
        supabase
          .from("master_livestock")
          .select("trace_no, grade, origin_country, source, species_group")
          .in("trace_no", traceNos),
        // 찍힌 번호마다 해당하는 명세서 줄 — 같은 번호, 두 칸 서식의 어느 칸, 로트↔개체 구성원 관계까지
        // DB 함수가 한 번에 본다(마이그레이션 116). 취소 서류는 함수가 제외한다.
        supabase.rpc("match_document_lines_for_traces", {
          p_wholesaler_id: scope.wholesalerId,
          p_trace_nos: traceNos,
        }),
      ]);

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

      // 같은 번호가 여러 명세서에 있으면 먼저 읽은 것을 쓴다 — 어느 쪽이 맞는지는
      // 사람이 판단할 문제라 여기서 고르지 않는다.
      // 함수가 (찍힌 번호, 줄) 짝을 문서 생성순·줄순으로 준다 — 번호당 첫 줄만 쓴다.
      ((docLineRows ?? []) as Array<Record<string, unknown>>).forEach((row) => {
        const key = String(row.scanned_trace_no);

        if (documentByTrace.has(key)) return;

        documentByTrace.set(key, {
          supplier: (row.supplier_name as string | null) ?? null,
          itemName: (row.item_name as string | null) ?? null,
          grade: (row.grade as string | null) ?? null,
          origin: (row.origin as string | null) ?? null,
          unitPrice: row.unit_price === null ? null : Number(row.unit_price),
          labeledWeight: row.labeled_weight === null ? null : Number(row.labeled_weight),
        });
      });
    }

    scanRequirements = Object.fromEntries(
      ((scanRows ?? []) as Array<Record<string, unknown>>).map((row) => {
        const traceNo = String(row.trace_no);
        const master = masterByTrace.get(traceNo);
        const document = documentByTrace.get(traceNo);
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
            purchaseUnitPrice:
              row.purchase_unit_price === null ? null : Number(row.purchase_unit_price),
            purchaseSupplier: (row.purchase_supplier as string | null) ?? null,
            traceFound: Boolean(master),
            apiSpecies: master?.species ?? null,
            apiGrade: master?.grade ?? null,
            apiOrigin: master?.origin ?? null,
            documentMatched: Boolean(document),
            documentSupplier: document?.supplier ?? null,
            documentItemName: document?.itemName ?? null,
            documentGrade: document?.grade ?? null,
            documentOrigin: document?.origin ?? null,
            documentUnitPrice: document?.unitPrice ?? null,
            documentLabeledWeight: document?.labeledWeight ?? null,
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
      purchaseUnitPrice: row.purchase_unit_price === null ? null : Number(row.purchase_unit_price),
      purchaseAmount: row.purchase_amount === null ? null : Number(row.purchase_amount),
      purchaseSupplier: (row.purchase_supplier as string | null) ?? null,
      scannedByName: row.scanned_by ? (scannerNameById.get(String(row.scanned_by)) ?? "직원") : null,
      storageLocation: (row.storage_location as string | null) ?? null,
      storageLocationPhotoPath: (row.storage_location_photo_path as string | null) ?? null,
    }));

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

  const configured = configuredTraceSources();

  // 문서 목록은 최신순이라, 대조를 안내할 때는 가장 오래 기다린 명세서부터 보도록 뒤집는다.
  const nextStep = pickInboundNextStep({
    pendingDocuments: documents
      .filter((doc) => doc.status === "PENDING")
      .reverse()
      .map((doc) => ({
        id: doc.id,
        completeLines: doc.matchSummary?.completeLines ?? 0,
        totalLines: doc.matchSummary?.totalLines ?? 0,
      })),
    awaitingLineCount: awaitingDocumentLines.length,
    needsCheckScanCount: scans.filter(
      (scan) => scan.status === "EXCEPTION" || scan.status === "PENDING_MAPPING"
    ).length,
    firstNeedsCheckScanId:
      scans.find((scan) => scan.status === "EXCEPTION" || scan.status === "PENDING_MAPPING")?.id ?? null,
  });

  // 원가(매입단가) 입력·명세서 완전 삭제 같은 관리 행위 권한 — DB의 can_manage_wholesaler()와
  // 같은 기준(owner 본인 / 조직 owner·manager / super_admin). 조직 없이 업체가 잡힌 건 owner다.
  const canManage = Boolean(
    scope &&
      (scope.isSuperAdmin ||
        scope.orgRole === "owner" ||
        scope.orgRole === "manager" ||
        (!scope.organizationId && scope.wholesalerId))
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>입고 스캔</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          바코드를 찍고 저울에 찍힌 <strong>실중량</strong>을 입력하면, 이력번호를 공공 이력제와
          대조해 재고에 반영하고 표기중량과의 차이·매입금액까지 함께 기록합니다.
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
          되지 않아 “확인 필요”로 쌓입니다. 키를 등록한 뒤 다시 조회하면 채워집니다.
        </div>
      ) : (
        <div style={{ fontSize: "12px", color: "#64748b" }}>
          이력 조회 가능: {configured.map((source) => SOURCE_LABELS[source] ?? source).join(" · ")}
        </div>
      )}

      <InboundNextStepCard step={nextStep} />

      <div id="inbound-documents" style={{ scrollMarginTop: "12px" }}>
        <InboundDocumentPanel products={products} documents={documents} canManageDocuments={canManage} />
      </div>

      <details>
        <summary style={{ fontSize: "13px", color: "#475569", cursor: "pointer", padding: "4px 0" }}>
          고급: 엑셀로 한꺼번에 입고하기
        </summary>
        <div style={{ marginTop: "10px" }}>
          <InboundImportPanel />
        </div>
      </details>

      <InboundScanView
        initialScans={scans}
        products={products}
        shippableOrders={shippableOrders}
        scanRequirements={scanRequirements}
        pendingDocumentTraceNos={pendingDocumentTraceNos}
        awaitingDocumentLines={awaitingDocumentLines}
        storageLocationSuggestions={storageLocationSuggestions}
        canEditPurchasePrice={canManage}
      />
    </div>
  );
}
