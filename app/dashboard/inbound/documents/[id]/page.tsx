import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import {
  lineArrival,
  suggestDocumentLinesForScan,
  type CountMode,
} from "@/lib/livestock/document-reconciliation";
import { speciesGroupFromTraceNumber } from "@/lib/livestock/trace-number";
import {
  DocumentReconciliationView,
  type ReconciliationLine,
  type UnlinkedBox,
  type UnlinkedBoxCandidate,
} from "./document-reconciliation-view";
import type { ScanProductOption } from "../../inbound-scan-view";

export const metadata = {
  title: "전표 대조 | 도매업체 통합관리시스템",
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}

/** 안 붙은 박스를 훑는 기본 기간 — 서류 날짜 기준 -7일 ~ +14일. 화면 위 날짜 두 칸으로 조절 가능(임의값, 스펙 3.3). */
const DEFAULT_RANGE_BEFORE_DAYS = 7;
const DEFAULT_RANGE_AFTER_DAYS = 14;

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

/** raw_text 끝의 "(이력번호 k/N)" 표식 — 한 줄에 번호 여럿을 나눈 줄에서 k>1이면 중량·수량이 첫 줄에만 있다. */
const SPLIT_MARKER = /\(이력번호 (\d+)\/(\d+)\)$/;

function splitIndexOf(rawText: string | null): number | null {
  const match = rawText?.match(SPLIT_MARKER);

  return match ? Number(match[1]) : null;
}

export default async function DocumentReconciliationPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  if (!scope?.wholesalerId) {
    notFound();
  }

  const supabase = await createClient();

  const { data: docRow } = await supabase
    .from("inbound_documents")
    .select("id, supplier_name, document_no, issued_on, status, note, storage_path, created_at")
    .eq("id", id)
    .eq("wholesaler_id", scope.wholesalerId)
    .maybeSingle();

  // 대조 화면은 PENDING(대조 중)·CLOSED(마감)만 다룬다(잠긴 결정) — DRAFT·DISCARDED는 이 화면에 볼 게 없다.
  if (!docRow || !["PENDING", "CLOSED"].includes(String(docRow.status))) {
    notFound();
  }

  const documentId = String(docRow.id);
  const supplierName = (docRow.supplier_name as string | null) ?? null;

  const { data: lineRows } = await supabase
    .from("inbound_document_lines")
    .select(
      "id, line_no, raw_text, item_name, product_id, trace_no, lot_no, part_name, grade, origin, quantity, labeled_weight, count_mode, products(name)"
    )
    .eq("document_id", documentId)
    .order("line_no", { ascending: true });

  const lines = (lineRows ?? []) as Array<Record<string, unknown>>;
  const lineIds = lines.map((row) => String(row.id));

  const { data: linkRows } =
    lineIds.length > 0
      ? await supabase
          .from("inbound_document_line_scans")
          .select("line_id, scan_id, linked_how, linked_at")
          .in("line_id", lineIds)
      : { data: [] as Array<Record<string, unknown>> };

  const links = (linkRows ?? []) as Array<Record<string, unknown>>;
  const linkedScanIds = [...new Set(links.map((row) => String(row.scan_id)))];

  const { data: linkedScanRows } =
    linkedScanIds.length > 0
      ? await supabase
          .from("inbound_scans")
          .select("id, trace_no, weight, status, created_at")
          .in("id", linkedScanIds)
      : { data: [] as Array<Record<string, unknown>> };

  const linkedScanById = new Map(
    ((linkedScanRows ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.id), row])
  );

  const linksByLineId = new Map<string, Array<Record<string, unknown>>>();

  links.forEach((row) => {
    const lineId = String(row.line_id);
    const list = linksByLineId.get(lineId) ?? [];

    list.push(row);
    linksByLineId.set(lineId, list);
  });

  // 안 붙은 박스 — 이 업체 박스 중 취소가 아니고 어느 줄에도 안 붙은 것. 기간은 서류 날짜 기준(스펙 3.3).
  const anchorDate = docRow.issued_on ? new Date(String(docRow.issued_on)) : new Date(String(docRow.created_at));
  const defaultFrom = toIsoDate(addDays(anchorDate, -DEFAULT_RANGE_BEFORE_DAYS));
  const defaultTo = toIsoDate(addDays(anchorDate, DEFAULT_RANGE_AFTER_DAYS));
  const rangeFrom = sp.from || defaultFrom;
  const rangeTo = sp.to || defaultTo;

  const { data: scansInRangeRows } = await supabase
    .from("inbound_scans")
    .select("id, trace_no, product_id, weight, status, created_at")
    .eq("wholesaler_id", scope.wholesalerId)
    .neq("status", "VOIDED")
    .gte("created_at", `${rangeFrom}T00:00:00`)
    .lte("created_at", `${rangeTo}T23:59:59`)
    .order("created_at", { ascending: false });

  const scansInRange = (scansInRangeRows ?? []) as Array<Record<string, unknown>>;
  const scanIdsInRange = scansInRange.map((row) => String(row.id));

  const { data: alreadyLinkedRows } =
    scanIdsInRange.length > 0
      ? await supabase.from("inbound_document_line_scans").select("scan_id").in("scan_id", scanIdsInRange)
      : { data: [] as Array<Record<string, unknown>> };

  const alreadyLinkedScanIds = new Set(
    ((alreadyLinkedRows ?? []) as Array<Record<string, unknown>>).map((row) => String(row.scan_id))
  );
  const unlinkedScans = scansInRange.filter((row) => !alreadyLinkedScanIds.has(String(row.id)));

  // 번호 후보 — 찍힌 번호마다 해당 줄(같은 번호·두 칸·로트↔개체)을 한 번에 조회(마이그레이션 116).
  // 함수가 이 업체 전체 전표를 대상으로 돌려주므로, (trace_no, lot_no) 짝이 이 문서 줄의 것과
  // 같은 것만 골라 좁힌다 — line_id를 직접 안 돌려주기 때문(내부 전용 document_lines_matching_trace는
  // authenticated 권한이 없어 여기서 못 부른다).
  const scannedTraceNos = [...new Set(unlinkedScans.map((row) => String(row.trace_no)))];

  const matchesByScannedTraceNo = new Map<string, Array<{ traceNo: string | null; lotNo: string | null }>>();

  if (scannedTraceNos.length > 0) {
    const { data: matchRows } = await supabase.rpc("match_document_lines_for_traces", {
      p_wholesaler_id: scope.wholesalerId,
      p_trace_nos: scannedTraceNos,
    });

    ((matchRows ?? []) as Array<Record<string, unknown>>).forEach((row) => {
      const key = String(row.scanned_trace_no);
      const list = matchesByScannedTraceNo.get(key) ?? [];

      list.push({
        traceNo: (row.trace_no as string | null) ?? null,
        lotNo: (row.lot_no as string | null) ?? null,
      });
      matchesByScannedTraceNo.set(key, list);
    });
  }

  function tupleKey(traceNo: string | null, lotNo: string | null): string {
    return `${traceNo ?? ""}|${lotNo ?? ""}`;
  }

  const lineIdsByTuple = new Map<string, string[]>();

  lines.forEach((row) => {
    const traceNo = (row.trace_no as string | null) ?? null;
    const lotNo = (row.lot_no as string | null) ?? null;

    if (!traceNo && !lotNo) return; // 번호 없는 줄은 다른 경로(제안)로 다룬다.

    const key = tupleKey(traceNo, lotNo);
    const list = lineIdsByTuple.get(key) ?? [];

    list.push(String(row.id));
    lineIdsByTuple.set(key, list);
  });

  // 번호 없는 줄 제안(스펙 3.3-2) — 박스 축종은 캐시(master_livestock), 없으면 이력번호에서 추론.
  const numberlessLines = lines.filter((row) => !row.trace_no && !row.lot_no);
  const scanTraceNosForSpecies = [...new Set(unlinkedScans.map((row) => String(row.trace_no)))];

  let speciesByTraceNo = new Map<string, string | null>();
  let masterPartByTraceNo = new Map<string, string | null>();

  if (scanTraceNosForSpecies.length > 0) {
    const { data: masterRows } = await supabase
      .from("master_livestock")
      .select("trace_no, species_group, part_name")
      .in("trace_no", scanTraceNosForSpecies);

    const masters = (masterRows ?? []) as Array<Record<string, unknown>>;

    speciesByTraceNo = new Map(masters.map((row) => [String(row.trace_no), (row.species_group as string | null) ?? null]));
    masterPartByTraceNo = new Map(masters.map((row) => [String(row.trace_no), (row.part_name as string | null) ?? null]));
  }

  // 줄의 도착 상태(박스 수/무게 기준) — 이어진(취소 제외) 박스의 무게로 계산한다.
  function arrivalOfRow(row: Record<string, unknown>) {
    const weights = (linksByLineId.get(String(row.id)) ?? [])
      .map((link) => linkedScanById.get(String(link.scan_id)))
      .filter((scan): scan is Record<string, unknown> => Boolean(scan) && scan?.status !== "VOIDED")
      .map((scan) => Number(scan.weight));

    return lineArrival(
      {
        countMode: (row.count_mode as CountMode | null) ?? null,
        quantity: row.quantity === null ? null : Number(row.quantity),
        labeledWeight: row.labeled_weight === null ? null : Number(row.labeled_weight),
        traceNo: (row.trace_no as string | null) ?? null,
        rawText: (row.raw_text as string | null) ?? null,
      },
      weights
    );
  }

  const suggestionLines = numberlessLines.map((row) => {
    const arrival = arrivalOfRow(row);
    const labeledWeight = row.labeled_weight === null ? null : Number(row.labeled_weight);

    return {
      lineId: String(row.id),
      itemText: [row.item_name, row.part_name].filter(Boolean).join(" "),
      expectedUnitWeight: labeledWeight === null ? null : labeledWeight / arrival.expected,
      remainingWeight:
        arrival.mode === "WEIGHT" && arrival.expectedWeight !== null
          ? Math.max(0, arrival.expectedWeight - arrival.linkedWeight)
          : null,
    };
  });

  // 상품 지정 드롭다운용 — 상품 목록
  const { data: productRows } = await supabase
    .from("products")
    .select("id, name, category, subcategory, grade, origin, unit")
    .eq("wholesaler_id", scope.wholesalerId)
    .eq("is_active", true)
    .order("name", { ascending: true });

  const products = (productRows ?? []) as ScanProductOption[];
  const productNameById = new Map(products.map((product) => [product.id, product.name]));
  const subcategoryByProductId = new Map(products.map((product) => [product.id, product.subcategory ?? null]));

  // 줄 목록 조립
  const reconciliationLines: ReconciliationLine[] = lines.map((row) => {
    const lineId = String(row.id);
    const lineLinks = linksByLineId.get(lineId) ?? [];

    const boxes = lineLinks
      .map((link) => {
        const scan = linkedScanById.get(String(link.scan_id));

        if (!scan) return null;

        return {
          scanId: String(scan.id),
          traceNo: String(scan.trace_no),
          weight: Number(scan.weight),
          status: scan.status as "NORMAL" | "PENDING_MAPPING" | "EXCEPTION" | "VOIDED",
          linkedHow: link.linked_how as "AUTO" | "MANUAL",
          linkedAt: String(link.linked_at),
          createdAt: String(scan.created_at),
        };
      })
      .filter((box): box is NonNullable<typeof box> => box !== null && box.status !== "VOIDED")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const arrival = arrivalOfRow(row);
    const productRow = row.products as { name: string } | { name: string }[] | null;
    const productName = Array.isArray(productRow) ? productRow[0]?.name ?? null : productRow?.name ?? null;
    const splitIndex = splitIndexOf((row.raw_text as string | null) ?? null);

    return {
      id: lineId,
      lineNo: Number(row.line_no),
      itemName: (row.item_name as string | null) ?? null,
      productId: (row.product_id as string | null) ?? null,
      productName,
      partName: (row.part_name as string | null) ?? null,
      grade: (row.grade as string | null) ?? null,
      origin: (row.origin as string | null) ?? null,
      traceNo: (row.trace_no as string | null) ?? null,
      lotNo: (row.lot_no as string | null) ?? null,
      expected: arrival.expected,
      linked: arrival.linkedBoxes,
      status: arrival.status,
      mode: arrival.mode,
      countMode: (row.count_mode as CountMode | null) ?? null,
      linkedWeight: arrival.linkedWeight,
      labeledWeight: row.labeled_weight === null ? null : Number(row.labeled_weight),
      isSplitContinuation: splitIndex !== null && splitIndex > 1,
      boxes,
    };
  });

  // 안 붙은 박스 조립 — 번호 후보 우선, 없으면 제안.
  const unlinkedBoxes: UnlinkedBox[] = unlinkedScans.map((row) => {
    const scanId = String(row.id);
    const traceNo = String(row.trace_no);

    const numberMatchRows = matchesByScannedTraceNo.get(traceNo) ?? [];
    const numberLineIds = new Set<string>();

    numberMatchRows.forEach((match) => {
      const key = tupleKey(match.traceNo, match.lotNo);

      (lineIdsByTuple.get(key) ?? []).forEach((lineId) => numberLineIds.add(lineId));
    });

    let candidates: UnlinkedBoxCandidate[];

    if (numberLineIds.size > 0) {
      candidates = [...numberLineIds].map((lineId) => ({
        lineId,
        basis: "NUMBER" as const,
      }));
    } else {
      const species = speciesByTraceNo.get(traceNo) ?? speciesGroupFromTraceNumber(traceNo);
      const productSubcategory = row.product_id ? subcategoryByProductId.get(String(row.product_id)) ?? null : null;
      const suggestions = suggestDocumentLinesForScan(
        {
          weight: Number(row.weight),
          speciesGroup: species,
          partName: masterPartByTraceNo.get(traceNo) ?? productSubcategory,
        },
        suggestionLines
      );

      candidates = suggestions.map((suggestion) => ({
        lineId: suggestion.lineId,
        basis: suggestion.speciesConfirmed ? "SUGGESTED" : "SUGGESTED_UNCONFIRMED",
        ...(suggestion.partConfirmed ? { partConfirmed: true as const } : {}),
      }));
    }

    return {
      scanId,
      traceNo,
      weight: Number(row.weight),
      status: row.status as "NORMAL" | "PENDING_MAPPING" | "EXCEPTION",
      productId: (row.product_id as string | null) ?? null,
      createdAt: String(row.created_at),
      candidates,
    };
  });

  return (
    <DocumentReconciliationView
      documentId={documentId}
      supplierName={supplierName}
      documentNo={(docRow.document_no as string | null) ?? null}
      issuedOn={(docRow.issued_on as string | null) ?? null}
      status={docRow.status as "PENDING" | "CLOSED"}
      note={(docRow.note as string | null) ?? null}
      hasFile={Boolean(docRow.storage_path)}
      lines={reconciliationLines.map((line) => ({
        ...line,
        productName: line.productId ? productNameById.get(line.productId) ?? line.productName : line.productName,
      }))}
      unlinkedBoxes={unlinkedBoxes}
      rangeFrom={rangeFrom}
      rangeTo={rangeTo}
      products={products}
    />
  );
}
