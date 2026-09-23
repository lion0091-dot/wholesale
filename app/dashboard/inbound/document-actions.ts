"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";

/**
 * 공급처 원본 명세서 저장 (29단계 A).
 *
 * 읽기·확인은 전부 브라우저에서 끝내고, 여기서는 사람이 확인한 결과만 받는다.
 * 파싱을 서버에서 하지 않는 이유는 틀리게 읽은 값이 그대로 저장되면 안 되기
 * 때문이다 — 화면에서 고친 최종본만 들어온다.
 *
 * 재고를 만들지 않는다. 재고는 박스 스캔만이 만든다(잠긴 결정).
 */

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/inbound";

/** 입고와 같은 기준 — 현장 작업이라 staff까지 허용한다. */
const DOCUMENT_ROLES: OrgRole[] = ["owner", "manager", "staff"];

/** 서버 액션 본문 한도(next.config의 bodySizeLimit)와 맞춘다. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface DocumentLineInput {
  lineNo: number;
  raw?: string | null;
  itemName?: string | null;
  productId?: string | null;
  traceNo?: string | null;
  quantity?: number | null;
  labeledWeight?: number | null;
  unitPrice?: number | null;
  amount?: number | null;
}

export interface SaveDocumentInput {
  supplierName: string;
  documentNo?: string | null;
  issuedOn?: string | null;
  totalAmount?: number | null;
  note?: string | null;
  entryMethod: "AUTO" | "MANUAL";
  /** 사람이 확정한 칸 위치. 같은 공급처 서류를 다음에 읽을 때 재사용한다. */
  columnMap?: Record<string, number> | null;
  sampleHeader?: string | null;
  lines: DocumentLineInput[];
}

export interface SavedDocument {
  documentId: string;
  lineCount: number;
  /** 원본 파일까지 보관됐는지 — 실패해도 저장 자체는 살린다. */
  fileStored: boolean;
}

async function resolveDocumentScope() {
  const context = await requireOrgRole(DOCUMENT_ROLES);
  const supabase = await createClient();

  let wholesalerId: string | null = null;

  if (context.organizationId) {
    const { data: organization } = await supabase
      .from("organizations")
      .select("wholesaler_id")
      .eq("id", context.organizationId)
      .maybeSingle();

    wholesalerId = (organization?.wholesaler_id as string | null) ?? null;
  }

  // super_admin은 조직 소속이 없는 한 자기 profile_id로 업체를 매칭하지 않는다
  // (actions.ts의 resolveInboundScope와 같은 판단).
  if (!wholesalerId && !context.isSuperAdmin) {
    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("id")
      .eq("profile_id", context.userId)
      .maybeSingle();

    wholesalerId = (wholesaler?.id as string | null) ?? null;
  }

  if (!wholesalerId) {
    throw new RbacError("공급사 업체 정보가 없어 명세서를 저장할 수 없습니다.");
  }

  return { supabase, context, wholesalerId };
}

/** 대소문자·공백 차이로 공급처 학습이 갈라지지 않게 맞춘다. */
function supplierKeyOf(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  console.error("[inbound-document]", error);

  return { success: false, error: "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." };
}

export async function saveInboundDocumentAction(
  formData: FormData
): Promise<ActionResult<SavedDocument>> {
  try {
    const { supabase, context, wholesalerId } = await resolveDocumentScope();

    const rawPayload = formData.get("payload");

    if (typeof rawPayload !== "string") {
      throw new RbacError("저장할 내용이 없습니다.");
    }

    const input = JSON.parse(rawPayload) as SaveDocumentInput;
    const supplierName = (input.supplierName ?? "").trim();

    if (!supplierName) {
      throw new RbacError("공급처 이름을 입력해주세요.");
    }

    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new RbacError("저장할 품목이 없습니다.");
    }

    const file = formData.get("file");
    const hasFile = file instanceof File && file.size > 0;

    if (hasFile && file.size > MAX_FILE_BYTES) {
      throw new RbacError("파일이 너무 큽니다. 8MB 이하로 올려주세요.");
    }

    const { data: created, error: insertError } = await supabase
      .from("inbound_documents")
      .insert({
        wholesaler_id: wholesalerId,
        supplier_name: supplierName,
        document_no: input.documentNo?.trim() || null,
        issued_on: input.issuedOn || null,
        total_amount: input.totalAmount ?? null,
        note: input.note?.trim() || null,
        entry_method: input.entryMethod === "MANUAL" ? "MANUAL" : "AUTO",
        file_name: hasFile ? file.name : null,
        mime_type: hasFile ? file.type || null : null,
        status: "PENDING",
        created_by: context.userId,
      })
      .select("id")
      .single();

    if (insertError || !created) {
      throw insertError ?? new Error("문서 저장 실패");
    }

    const documentId = String(created.id);

    // 원본 파일 보관. 경로 첫 칸이 업체 UUID여야 Storage 정책을 통과한다.
    let fileStored = false;

    if (hasFile) {
      const safeName = file.name.replace(/[^\w.\-가-힣]/g, "_").slice(-120);
      const path = `${wholesalerId}/${documentId}/${safeName}`;
      const { error: uploadError } = await supabase.storage
        .from("inbound-documents")
        .upload(path, Buffer.from(await file.arrayBuffer()), {
          contentType: file.type || "application/octet-stream",
          upsert: true,
        });

      if (uploadError) {
        // 원본 보관에 실패해도 읽어낸 내용은 살린다 — 다시 올릴 수 있게 안내만 한다.
        console.error("[inbound-document] 원본 보관 실패", uploadError);
      } else {
        fileStored = true;
        await supabase
          .from("inbound_documents")
          .update({ storage_path: path })
          .eq("id", documentId);
      }
    }

    const lineRows = input.lines.map((line, index) => ({
      document_id: documentId,
      line_no: line.lineNo ?? index + 1,
      raw_text: line.raw ?? null,
      item_name: line.itemName?.trim() || null,
      product_id: line.productId || null,
      trace_no: line.traceNo?.trim() || null,
      quantity: line.quantity ?? null,
      labeled_weight: line.labeledWeight ?? null,
      unit_price: line.unitPrice ?? null,
      amount: line.amount ?? null,
    }));

    const { error: linesError } = await supabase
      .from("inbound_document_lines")
      .insert(lineRows);

    if (linesError) {
      // 줄이 없는 문서는 쓸모가 없다. 껍데기만 남기지 않고 되돌린다.
      await supabase.from("inbound_documents").delete().eq("id", documentId);
      throw linesError;
    }

    // 사람이 확정한 칸 위치를 공급처별로 학습해둔다.
    if (input.columnMap && Object.keys(input.columnMap).length > 0) {
      await supabase.from("supplier_document_formats").upsert(
        {
          wholesaler_id: wholesalerId,
          supplier_key: supplierKeyOf(supplierName),
          supplier_name: supplierName,
          column_map: input.columnMap,
          sample_header: input.sampleHeader ?? null,
        },
        { onConflict: "wholesaler_id,supplier_key" }
      );
    }

    revalidatePath(REVALIDATE_PATH);

    return {
      success: true,
      data: { documentId, lineCount: lineRows.length, fileStored },
    };
  } catch (error) {
    return toResult(error);
  }
}

export interface LearnedFormat {
  supplierName: string;
  columnMap: Record<string, number>;
}

/** 같은 공급처 서류를 전에 읽어봤으면 그때 짚어준 칸 위치를 돌려준다. */
export async function loadSupplierFormatAction(
  supplierName: string
): Promise<ActionResult<LearnedFormat | null>> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();
    const key = supplierKeyOf(supplierName ?? "");

    if (!key) {
      return { success: true, data: null };
    }

    const { data } = await supabase
      .from("supplier_document_formats")
      .select("supplier_name, column_map")
      .eq("wholesaler_id", wholesalerId)
      .eq("supplier_key", key)
      .maybeSingle();

    if (!data) {
      return { success: true, data: null };
    }

    return {
      success: true,
      data: {
        supplierName: String(data.supplier_name),
        columnMap: (data.column_map ?? {}) as Record<string, number>,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/** 잘못 올린 서류 치우기. 재고와 무관하므로 삭제가 안전하다. */
export async function deleteInboundDocumentAction(
  documentId: string
): Promise<ActionResult> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();

    const { data: existing } = await supabase
      .from("inbound_documents")
      .select("id, storage_path")
      .eq("id", documentId)
      .eq("wholesaler_id", wholesalerId)
      .maybeSingle();

    if (!existing) {
      throw new RbacError("해당 명세서를 찾을 수 없습니다.");
    }

    if (existing.storage_path) {
      await supabase.storage
        .from("inbound-documents")
        .remove([String(existing.storage_path)]);
    }

    // 줄은 ON DELETE CASCADE로 함께 지워진다.
    const { error } = await supabase
      .from("inbound_documents")
      .delete()
      .eq("id", documentId)
      .eq("wholesaler_id", wholesalerId);

    if (error) throw error;

    revalidatePath(REVALIDATE_PATH);

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

/** 보관된 원본을 잠깐 열어보는 링크. 비공개 버킷이라 서명이 필요하다. */
export async function getDocumentFileUrlAction(
  documentId: string
): Promise<ActionResult<string>> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();

    const { data } = await supabase
      .from("inbound_documents")
      .select("storage_path")
      .eq("id", documentId)
      .eq("wholesaler_id", wholesalerId)
      .maybeSingle();

    if (!data?.storage_path) {
      throw new RbacError("보관된 원본 파일이 없습니다.");
    }

    const { data: signed, error } = await supabase.storage
      .from("inbound-documents")
      .createSignedUrl(String(data.storage_path), 60 * 5);

    if (error || !signed) {
      throw error ?? new Error("링크 생성 실패");
    }

    return { success: true, data: signed.signedUrl };
  } catch (error) {
    return toResult(error);
  }
}
