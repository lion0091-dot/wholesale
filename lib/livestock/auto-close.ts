import type { createClient } from "@/lib/supabase/server";
import { documentLineExpectedQty, documentLineMatchStatus } from "./document-reconciliation";

/**
 * 전표 자동 마감 — 모든 줄이 예정대로 도착했고 상품이 안 정해진 박스도 없으면 사람이 할 일이 없으므로
 * 마감해 둔다(마감은 서류 정리 표시일 뿐 재고와 무관하고 "다시 열기"로 되돌릴 수 있다).
 *
 * 검사는 "그 전표의 박스를 찍거나·상품을 지정하거나·이은" 순간에만 한다. 사람이 다시 열어 고치는 중에는
 * 건드리지 않아야 해서, 전표 전체를 훑는 주기 작업으로 만들지 않았다.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

interface ScanRef {
  inbound_scans: { status: string } | { status: string }[] | null;
}

export interface AutoCloseLine {
  quantity: number | null;
  inbound_document_line_scans: ScanRef[] | null;
}

function scanStatusOf(link: ScanRef): string | undefined {
  const scan = Array.isArray(link.inbound_scans) ? link.inbound_scans[0] : link.inbound_scans;

  return scan?.status;
}

/** 줄이 하나 이상이고, 모든 줄이 정확히 다 도착했고, 이어진 박스 중 상품 미지정·이력 미확인이 없을 때만 참. */
export function isDocumentReadyToAutoClose(lines: AutoCloseLine[]): boolean {
  if (lines.length === 0) return false;

  return lines.every((line) => {
    let linked = 0;

    for (const link of line.inbound_document_line_scans ?? []) {
      const status = scanStatusOf(link);

      if (status === "VOIDED") continue;
      if (status === "EXCEPTION" || status === "PENDING_MAPPING") return false;

      linked += 1;
    }

    const expected = documentLineExpectedQty(line.quantity === null ? null : Number(line.quantity));

    return documentLineMatchStatus(expected, linked) === "COMPLETE";
  });
}

/** 준비된 전표를 마감한다. 실패해도 호출한 작업(스캔·지정 등)은 이미 끝났으므로 조용히 넘긴다. 마감한 id를 돌려준다. */
export async function autoCloseDocuments(supabase: Client, documentIds: string[]): Promise<string[]> {
  const ids = [...new Set(documentIds)];

  if (ids.length === 0) return [];

  try {
    const { data } = await supabase
      .from("inbound_documents")
      .select("id, status, inbound_document_lines(quantity, inbound_document_line_scans(inbound_scans(status)))")
      .in("id", ids)
      .eq("status", "PENDING");

    const closed: string[] = [];

    for (const row of (data ?? []) as Array<{ id: string; inbound_document_lines: AutoCloseLine[] | null }>) {
      if (!isDocumentReadyToAutoClose(row.inbound_document_lines ?? [])) continue;

      const { error } = await supabase.rpc("close_inbound_document", { p_document_id: row.id, p_note: null });

      if (error) {
        console.error("[inbound] 전표 자동 마감 실패:", error.message);
        continue;
      }

      closed.push(row.id);
    }

    return closed;
  } catch (error) {
    console.error("[inbound] 전표 자동 마감 검사 실패:", error);
    return [];
  }
}

/** 이 박스가 이어져 있는 전표들을 찾아 자동 마감을 시도한다. */
export async function autoCloseDocumentsForScan(supabase: Client, scanId: string): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("inbound_document_line_scans")
      .select("inbound_document_lines(document_id)")
      .eq("scan_id", scanId);

    const documentIds = ((data ?? []) as Array<Record<string, unknown>>)
      .map((row) => {
        const line = Array.isArray(row.inbound_document_lines) ? row.inbound_document_lines[0] : row.inbound_document_lines;

        return (line as { document_id?: string } | null)?.document_id ?? null;
      })
      .filter((id): id is string => Boolean(id));

    return await autoCloseDocuments(supabase, documentIds);
  } catch (error) {
    console.error("[inbound] 자동 마감 대상 조회 실패:", error);
    return [];
  }
}
