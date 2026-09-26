import { createClient } from "@/lib/supabase/server";
import type { getSupplierScope } from "@/lib/supplier/scope";
import type {
  InboundScanRow,
  ScanProductOption,
  ShippableOrderOption,
  AwaitingDocumentLine,
} from "./inbound-scan-view";
import type { InboundDocumentRow } from "./inbound-document-panel";
import {
  buildScanRequirementReport,
  resolveTraceOrigin,
  type ScanRequirementReport,
} from "@/lib/livestock/inbound-requirements";
import { lineArrival, type CountMode } from "@/lib/livestock/document-reconciliation";
import { loadWeightTolerance } from "@/lib/livestock/weight-tolerance";
import type { InboundNextStepInput } from "@/lib/livestock/inbound-next-step";

type SupplierScope = Awaited<ReturnType<typeof getSupplierScope>>;

export interface InboundData {
  scans: InboundScanRow[];
  products: ScanProductOption[];
  shippableOrders: ShippableOrderOption[];
  documents: InboundDocumentRow[];
  scanRequirements: Record<string, ScanRequirementReport>;
  pendingDocumentTraceNos: string[];
  awaitingDocumentLines: AwaitingDocumentLine[];
  storageLocationSuggestions: string[];
  /** 안내 카드(현장용·사무실용 둘 다)가 받는 입력. */
  nextStepInput: InboundNextStepInput;
  /** 아직 안 들어온 박스 수(전표 기준). 무게 기준 줄은 덜 온 줄마다 1로 센다. */
  remainingBoxCount: number;
  /** 위 수 중 무게 기준 줄의 몫 — 안내 문구가 "박스 N개"와 "무게가 덜 찬 줄 M줄"을 나눠 말하는 데 쓴다. */
  remainingWeightLines: number;
  canManage: boolean;
}

/**
 * 입고 스캔(현장)과 전표입력(사무실) 두 화면이 같이 쓰는 조회.
 * scanDetails=false면 박스마다 필수 항목을 대조하는 무거운 부분(공공 이력·전표 줄 조회, 직원 이름)을 건너뛴다 —
 * 전표입력 화면은 박스 목록을 그리지 않는다.
 */
export async function loadInboundData(
  scope: SupplierScope,
  options: { scanDetails: boolean }
): Promise<InboundData> {
  let scans: InboundScanRow[] = [];
  let products: ScanProductOption[] = [];
  let shippableOrders: ShippableOrderOption[] = [];
  let documents: InboundDocumentRow[] = [];
  let scanRequirements: Record<string, ScanRequirementReport> = {};
  // "박스 나눠서 입고"에서 줄마다 적은(또는 박스 코드를 그대로 재사용한) 이력번호가
  // 올려둔 전표에 실제로 있는 번호인지 대조하는 배너용 — 대기중(PENDING) 전표
  // 줄에 적힌 번호만 모은다. 전표 자체가 없으면 대조할 게 없으니 조용히 넘어간다.
  let pendingDocumentTraceNos: string[] = [];
  // 전표엔 있는데 아직 스캔 안 된 줄 — "전표 대기 품목" 목록(탭하면 이력번호
  // 입력칸을 채워줌)에 쓴다. 최근 100건짜리 scans 배열로 대조하면 오래된 전표
  // 건이 그 창밖으로 밀려나 잘못 "아직 안 들어옴"으로 보일 수 있어, 이 줄들의
  // 이력번호만 따로 모아 inbound_scans 전체에서 존재 여부를 확인한다.
  let awaitingDocumentLines: AwaitingDocumentLine[] = [];
  // 위 줄들이 기다리는 박스 수(수량 반영) — "지금 할 일" 카드용.
  let awaitingBoxCount = 0;
  let awaitingWeightLines = 0;
  let lateBoxes: Array<{ scanId: string; documentId: string }> = [];
  let unlinkedOpenBoxes: Array<{ scanId: string; documentId: string }> = [];
  // 창고 구조가 업체마다 달라(플랫폼) 고정 위치 목록 대신, 이 업체가 그동안
  // 직접 입력한 위치 이름을 제안 목록으로 쓴다.
  let storageLocationSuggestions: string[] = [];


  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const weightTolerance = await loadWeightTolerance(supabase, scope.wholesalerId);

    // 다른 조회와 나란히 보낸다(순서대로 기다리면 화면을 열 때마다 그만큼 늦어진다). 결과는 아래에서 받는다.
    const unlinkedRowsPromise = supabase.rpc("list_unlinked_boxes_for_documents", {
      p_wholesaler_id: scope.wholesalerId,
    });

    // 입고 내역은 계속 쌓이기만 하므로 최근 100건만 불러온다. 현장에서 보는 건
    // "방금 찍은 것들"이고, 과거 조회는 이력관리 메뉴가 따로 담당한다.
    // 주문 목록은 출고 스캔 화면(app/dashboard/outbound/page.tsx)과 같은 기준
    // (확정·배송중만)이다 — "이 박스 특정 주문으로 바로 보내기"가 결국 출고 스캔을
    // 대신 호출하므로 같은 상태만 배정 대상이어야 한다.
    const [{ data: recentScanRows }, { data: openScanRows }, { data: productRows }, { data: orderRows }, { data: pendingDocLineRows }] =
      await Promise.all([
        supabase
          .from("inbound_scans")
          .select(
            "id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight, created_at, labeled_weight, weight_variance, purchase_unit_price, purchase_amount, purchase_supplier, scanned_by, storage_location, storage_location_photo_path"
          )
          .eq("wholesaler_id", scope.wholesalerId)
          .order("created_at", { ascending: false })
          .limit(100),
        // 확인이 필요한 박스(이력 못 찾음·상품 미확정)는 최근 100건 밖으로 밀려나도 화면에 남겨야 한다 —
        // 종 배지는 전부 세는데 여기서만 빠지면 "확인 필요 1"인데 찾을 수 없는 박스가 된다.
        supabase
          .from("inbound_scans")
          .select(
            "id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight, created_at, labeled_weight, weight_variance, purchase_unit_price, purchase_amount, purchase_supplier, scanned_by, storage_location, storage_location_photo_path"
          )
          .eq("wholesaler_id", scope.wholesalerId)
          .in("status", ["EXCEPTION", "PENDING_MAPPING"])
          .order("created_at", { ascending: false })
          .limit(200),
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
            "id, trace_no, lot_no, item_name, labeled_weight, unit_price, quantity, raw_text, count_mode, inbound_documents!inner(status, supplier_name)"
          )
          .eq("inbound_documents.status", "PENDING")
          .or("trace_no.not.is.null,lot_no.not.is.null")
          .order("line_no", { ascending: true }),
      ]);

    const { data: unlinkedRows } = await unlinkedRowsPromise;
    const unlinked = ((unlinkedRows ?? []) as Array<{ scan_id: string; document_id: string; document_status: string }>).map((row) => ({
      scanId: String(row.scan_id),
      documentId: String(row.document_id),
      documentStatus: row.document_status,
    }));
    lateBoxes = unlinked.filter((row) => row.documentStatus === "CLOSED");
    unlinkedOpenBoxes = unlinked.filter((row) => row.documentStatus === "PENDING");

    pendingDocumentTraceNos = [
      ...new Set(
        ((pendingDocLineRows ?? []) as Array<{ trace_no: string | null; lot_no: string | null }>)
          .flatMap((row) => [row.trace_no, row.lot_no])
          .map((value) => (value ?? "").trim().toUpperCase())
          .filter((value) => value.length > 0)
      ),
    ];

    if (pendingDocumentTraceNos.length > 0) {
      // "아직 안 만난 줄" 판정은 DB가 한다 — 같은 번호뿐 아니라 전표는 로트·박스는 개체번호(또는 반대)인
      // 경우도 로트 구성원 목록(master_livestock.raw_payload)으로 이어 본다(마이그레이션 116).
      const { data: awaitingIdRows } = await supabase.rpc("list_awaiting_document_line_ids", {
        p_wholesaler_id: scope.wholesalerId,
      });
      const awaitingIds = new Set(((awaitingIdRows ?? []) as string[]).map(String));

      // 아직 한 박스도 안 만난 줄 — 박스 기준이면 예정 박스 수 전체, 무게 기준이면 1(적어도 한 박스)이다.
      ((pendingDocLineRows ?? []) as Array<Record<string, unknown>>)
        .filter((row) => awaitingIds.has(String(row.id)))
        .forEach((row) => {
          const arrival = lineArrival(
            {
              countMode: (row.count_mode as CountMode | null) ?? null,
              quantity: row.quantity === null ? null : Number(row.quantity),
              labeledWeight: row.labeled_weight === null ? null : Number(row.labeled_weight),
              traceNo: (row.trace_no as string | null) ?? null,
              rawText: (row.raw_text as string | null) ?? null,
            },
            [],
            weightTolerance
          );

          awaitingBoxCount += arrival.remainingBoxes;
          if (arrival.mode === "WEIGHT") awaitingWeightLines += 1;
        });

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

    // 올린 전표 목록. 저장만 되고 다시 열어볼 곳이 없으면 쓸모가 없어서 함께 내린다.
    // 대조 화면(29단계 B) 진입 배지용 줄 상태 요약에 필요한 줄·연결표·박스 상태까지
    // 전표 아래에 중첩해 한 번에 받는다 — 전표 ≤30건이라 행 상한에 안 걸리고, 줄 id를
    // 모아 .in()으로 다시 조회하지 않으므로 URL 길이 한도로 결과가 잘리는 일이 없다.
    const { data: documentRows } = await supabase
      .from("inbound_documents")
      .select(
        "id, supplier_name, document_no, issued_on, file_name, storage_path, status, total_amount, created_at, scan_finished_at, inbound_document_lines(id, quantity, labeled_weight, trace_no, lot_no, raw_text, count_mode, inbound_document_line_scans(scan_id, inbound_scans(status, weight)))"
      )
      .eq("wholesaler_id", scope.wholesalerId)
      .order("created_at", { ascending: false })
      .limit(30);

    type NestedDocumentLine = {
      id: string;
      quantity: number | null;
      labeled_weight: number | null;
      trace_no: string | null;
      lot_no: string | null;
      raw_text: string | null;
      count_mode: CountMode | null;
      inbound_document_line_scans: Array<{
        scan_id: string;
        inbound_scans: { status: string; weight: number | string } | { status: string; weight: number | string }[] | null;
      }> | null;
    };

    // 카드 버튼이 #scan-<id>로 이동하므로, 화면에 실제로 그려진(최근 100건) 박스만 후보로 삼는다.
    const scanRows = [
      ...new Map(
        [...((recentScanRows ?? []) as Array<Record<string, unknown>>), ...((openScanRows ?? []) as Array<Record<string, unknown>>)].map((row) => [String(row.id), row])
      ).values(),
    ].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));

    const visibleScanIds = new Set(((scanRows ?? []) as Array<{ id: string }>).map((row) => String(row.id)));

    const matchSummaryByDocId = new Map<
      string,
      {
        completeLines: number;
        totalLines: number;
        partialBoxesRemaining: number;
        partialWeightLines: number;
        unresolvedBoxes: number;
        firstUnresolvedScanId: string | null;
      }
    >();

    ((documentRows ?? []) as Array<Record<string, unknown>>).forEach((row) => {
      if (row.status !== "PENDING" && row.status !== "CLOSED") return;

      const lines = (row.inbound_document_lines as NestedDocumentLine[] | null) ?? [];

      if (lines.length === 0) return;

      const summary = {
        completeLines: 0,
        totalLines: 0,
        partialBoxesRemaining: 0,
        partialWeightLines: 0,
        unresolvedBoxes: 0,
        firstUnresolvedScanId: null as string | null,
      };

      lines.forEach((line) => {
        const weights: number[] = [];

        (line.inbound_document_line_scans ?? []).forEach((link) => {
          const scan = Array.isArray(link.inbound_scans) ? link.inbound_scans[0] : link.inbound_scans;
          const scanStatus = scan?.status;

          if (scanStatus === "VOIDED") return;

          // 전표와 이어졌어도 상품이 안 정해진 박스는 재고에 아직 안 들어간다.
          if (scanStatus === "EXCEPTION" || scanStatus === "PENDING_MAPPING") {
            summary.unresolvedBoxes += 1;

            if (!summary.firstUnresolvedScanId && visibleScanIds.has(String(link.scan_id))) {
              summary.firstUnresolvedScanId = String(link.scan_id);
            }
          }

          weights.push(Number(scan?.weight ?? 0));
        });

        const arrival = lineArrival(
          {
            countMode: line.count_mode,
            quantity: line.quantity === null ? null : Number(line.quantity),
            labeledWeight: line.labeled_weight === null ? null : Number(line.labeled_weight),
            traceNo: line.trace_no,
            rawText: line.raw_text,
          },
          weights,
          weightTolerance
        );

        summary.totalLines += 1;
        if (arrival.status === "COMPLETE") summary.completeLines += 1;
        // 일부만 온 줄은 모자란 박스가 더 와야 한다 — 이건 맞춰 볼 일이 아니라 찍을 일이다.
        // (무게 기준 줄은 덜 찬 줄마다 "적어도 한 박스"로 센다.)
        // 번호가 없는 줄은 위 "안 들어온 줄" 조회에 안 잡힌다(번호로 찾는 조회) — 예정 수량 전체가 남은 박스다.
        const stillNeeds =
          arrival.status === "PARTIAL" || (arrival.status === "AWAITING" && !line.trace_no && !line.lot_no);

        if (stillNeeds) {
          summary.partialBoxesRemaining += arrival.remainingBoxes;
          if (arrival.mode === "WEIGHT") summary.partialWeightLines += 1;
        }
      });

      matchSummaryByDocId.set(String(row.id), summary);
    });

    documents = ((documentRows ?? []) as Array<Record<string, unknown>>).map((row) => {
      const documentLines = (row.inbound_document_lines as unknown[] | null) ?? [];

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
        lineCount: documentLines.length,
        scanFinished: Boolean(row.scan_finished_at),
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
    // 다 봐야 한다 — 스캔 자체, 공공 이력조회(master_livestock), 올라온 전표.
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

    if (options.scanDetails && traceNos.length > 0) {
      const [{ data: masterRows }, { data: docLineRows }] = await Promise.all([
        supabase
          .from("master_livestock")
          .select("trace_no, grade, origin_country, source, species_group")
          .in("trace_no", traceNos),
        // 찍힌 번호마다 해당하는 전표 줄 — 같은 번호, 두 칸 서식의 어느 칸, 로트↔개체 구성원 관계까지
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

      // 같은 번호가 여러 전표에 있으면 먼저 읽은 것을 쓴다 — 어느 쪽이 맞는지는
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

    scanRequirements = !options.scanDetails ? {} : Object.fromEntries(
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

    if (options.scanDetails && scannedByIds.length > 0) {
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

  const pendingDocuments = documents.filter((doc) => doc.status === "PENDING");
  const nextStepRemainingWeightLines =
    awaitingWeightLines + pendingDocuments.reduce((sum, doc) => sum + (doc.matchSummary?.partialWeightLines ?? 0), 0);

  const nextStepRemainingBoxCount =
    awaitingBoxCount +
    documents
      .filter((doc) => doc.status === "PENDING")
      .reduce((sum, doc) => sum + (doc.matchSummary?.partialBoxesRemaining ?? 0), 0);

  // 문서 목록은 최신순이라, 대조를 안내할 때는 가장 오래 기다린 전표부터 보도록 뒤집는다.
  const nextStepInput: InboundNextStepInput = {
    pendingDocuments: documents
      .filter((doc) => doc.status === "PENDING")
      .reverse()
      .map((doc) => ({
        id: doc.id,
        supplierName: doc.supplierName,
        scanFinished: doc.scanFinished,
        completeLines: doc.matchSummary?.completeLines ?? 0,
        totalLines: doc.matchSummary?.totalLines ?? 0,
        unresolvedBoxes: doc.matchSummary?.unresolvedBoxes ?? 0,
        firstUnresolvedScanId: doc.matchSummary?.firstUnresolvedScanId ?? null,
      })),
    remainingBoxCount: nextStepRemainingBoxCount,
    remainingWeightLines: nextStepRemainingWeightLines,
    needsCheckScanCount: scans.filter(
      (scan) => scan.status === "EXCEPTION" || scan.status === "PENDING_MAPPING"
    ).length,
    firstNeedsCheckScanId:
      scans.find((scan) => scan.status === "EXCEPTION" || scan.status === "PENDING_MAPPING")?.id ?? null,
    lateBoxes,
    unlinkedOpenBoxes,
  };

  // 원가(매입단가) 입력·전표 완전 삭제 같은 관리 행위 권한 — DB의 can_manage_wholesaler()와
  // 같은 기준(owner 본인 / 조직 owner·manager / super_admin). 조직 없이 업체가 잡힌 건 owner다.
  const canManage = Boolean(
    scope &&
      (scope.isSuperAdmin ||
        scope.orgRole === "owner" ||
        scope.orgRole === "manager" ||
        (!scope.organizationId && scope.wholesalerId))
  );

  return {
    scans,
    products,
    shippableOrders,
    documents,
    scanRequirements,
    pendingDocumentTraceNos,
    awaitingDocumentLines,
    storageLocationSuggestions,
    nextStepInput,
    remainingBoxCount: nextStepRemainingBoxCount,
    remainingWeightLines: nextStepRemainingWeightLines,
    canManage,
  };
}
