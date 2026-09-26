import type { createClient } from "@/lib/supabase/server";
import {
  lineArrival,
  pickAutoLinkLine,
  pickLineByPart,
  suggestDocumentLinesForScan,
  type CountMode,
} from "./document-reconciliation";
import { speciesGroupFromTraceNumber } from "./trace-number";

/**
 * 번호로 한 줄이 안 정해진 박스를 부위로 마저 이어 준다(재고는 만들지 않는다 — 연결은 확인용).
 *
 * 1) 번호가 전표 줄에 있는데 줄이 여럿(한 마리를 여러 부위로 쪼갠 전표) → 박스 부위가 적힌 줄이 하나면 그 줄.
 * 2) 번호가 전표 어느 줄에도 없음 → 번호 없는 줄 중 무게(±10%)·축종·부위가 맞는 자리 남은 줄이 하나면 그 줄.
 * 애매하면 잇지 않고 사무실 대조 화면 몫으로 남긴다.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

interface LineRow {
  id: string;
  quantity: number | null;
  labeled_weight: number | null;
  item_name: string | null;
  part_name: string | null;
  trace_no: string | null;
  lot_no: string | null;
  raw_text: string | null;
  count_mode: CountMode | null;
  inbound_document_line_scans: Array<{
    inbound_scans: { status: string; weight: number | string } | { status: string; weight: number | string }[] | null;
  }> | null;
}

function arrivalOf(line: LineRow) {
  const weights = (line.inbound_document_line_scans ?? [])
    .map((link) => (Array.isArray(link.inbound_scans) ? link.inbound_scans[0] : link.inbound_scans))
    .filter((scan): scan is { status: string; weight: number | string } => Boolean(scan) && scan?.status !== "VOIDED")
    .map((scan) => Number(scan.weight));

  return lineArrival(
    {
      countMode: line.count_mode,
      quantity: line.quantity === null ? null : Number(line.quantity),
      labeledWeight: line.labeled_weight === null ? null : Number(line.labeled_weight),
      traceNo: line.trace_no,
      rawText: line.raw_text,
    },
    weights
  );
}

function itemTextOf(line: LineRow): string {
  return [line.item_name, line.part_name].filter(Boolean).join(" ");
}

/** 이은 줄 id를 돌려준다. 잇지 않았으면 null. 실패해도 입고는 이미 끝났으므로 조용히 넘긴다. */
export async function autoLinkNumberlessScan(supabase: Client, scanId: string): Promise<string | null> {
  try {
    const { data: scan } = await supabase
      .from("inbound_scans")
      .select("id, wholesaler_id, trace_no, weight, status, product_id")
      .eq("id", scanId)
      .maybeSingle();

    if (!scan || scan.status === "VOIDED") return null;

    const { data: existing } = await supabase
      .from("inbound_document_line_scans")
      .select("line_id")
      .eq("scan_id", scanId)
      .maybeSingle();

    if (existing) return null;

    const [{ data: master }, { data: product }, { data: numberMatches }] = await Promise.all([
      supabase.from("master_livestock").select("species_group, part_name").eq("trace_no", scan.trace_no).maybeSingle(),
      scan.product_id
        ? supabase.from("products").select("subcategory").eq("id", scan.product_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.rpc("match_document_lines_for_traces", {
        p_wholesaler_id: scan.wholesaler_id,
        p_trace_nos: [scan.trace_no],
      }),
    ]);

    const partName =
      (master?.part_name as string | null | undefined)?.trim() ||
      (product?.subcategory as string | null | undefined)?.trim() ||
      null;

    if (!partName) return null;

    const { data: lineRows } = await supabase
      .from("inbound_document_lines")
      .select(
        "id, quantity, labeled_weight, item_name, part_name, trace_no, lot_no, raw_text, count_mode, " +
          "inbound_documents!inner(status, wholesaler_id), inbound_document_line_scans(inbound_scans(status, weight))"
      )
      .eq("inbound_documents.status", "PENDING")
      .eq("inbound_documents.wholesaler_id", scan.wholesaler_id);

    const openLines = ((lineRows ?? []) as unknown as LineRow[]).filter((line) => arrivalOf(line).roomLeft);
    const matches = (numberMatches ?? []) as Array<{ trace_no: string | null; lot_no: string | null }>;

    let lineId: string | null = null;

    if (matches.length > 0) {
      const keys = new Set(matches.map((match) => `${match.trace_no ?? ""}|${match.lot_no ?? ""}`));
      const byNumber = openLines.filter((line) => keys.has(`${line.trace_no ?? ""}|${line.lot_no ?? ""}`));

      // 줄이 하나뿐이면 DB의 번호 배정이 이미 처리했다. 여럿일 때만 부위로 고른다.
      if (byNumber.length > 1) {
        lineId = pickLineByPart(
          byNumber.map((line) => ({ lineId: line.id, itemText: itemTextOf(line) })),
          partName
        );
      }
    } else {
      const numberless = openLines.filter((line) => !line.trace_no && !line.lot_no);

      if (numberless.length > 0) {
        const suggestions = suggestDocumentLinesForScan(
          {
            weight: Number(scan.weight),
            speciesGroup: (master?.species_group as string | null | undefined) ?? speciesGroupFromTraceNumber(scan.trace_no),
            partName,
          },
          numberless.map((line) => {
            const arrival = arrivalOf(line);
            const labeledWeight = line.labeled_weight === null ? null : Number(line.labeled_weight);

            return {
              lineId: line.id,
              itemText: itemTextOf(line),
              expectedUnitWeight: labeledWeight === null ? null : labeledWeight / arrival.expected,
              remainingWeight:
                arrival.mode === "WEIGHT" && arrival.expectedWeight !== null
                  ? Math.max(0, arrival.expectedWeight - arrival.linkedWeight)
                  : null,
            };
          })
        );

        lineId = pickAutoLinkLine(suggestions);
      }
    }

    if (!lineId) return null;

    const { error } = await supabase.rpc("link_scan_to_document_line", {
      p_scan_id: scanId,
      p_line_id: lineId,
      p_how: "AUTO",
    });

    if (error) {
      console.error("[inbound] 부위 기준 자동 배정 실패:", error.message);
      return null;
    }

    return lineId;
  } catch (error) {
    console.error("[inbound] 부위 기준 자동 배정 검사 실패:", error);
    return null;
  }
}
