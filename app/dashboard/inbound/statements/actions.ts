"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";

/**
 * 공급처 명세서 파일 보관함(마이그레이션 164). 파일 내용은 읽지 않고 보관만 한다.
 * 파일 자체는 브라우저가 Storage 버킷 inbound-documents에 직접 올리고(서버리스 요청 용량 한도
 * 회피), 여기서는 그 기록(목록 한 줄)만 저장한다. 삭제는 없고 숨김만 있다.
 */

const STATEMENT_BUCKET = "inbound-documents";

interface ActionResult {
  success: boolean;
  error?: string;
  url?: string;
}

export interface RecordStatementFileInput {
  storagePath: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  supplierId: string | null;
  statementDate: string | null;
  memo: string | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function recordStatementFileAction(input: RecordStatementFileInput): Promise<ActionResult> {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    return { success: false, error: "공급사 정보를 찾을 수 없습니다." };
  }

  // 경로가 이 업체 폴더가 아니면 거부한다(DB CHECK와 이중 방어).
  if (!input.storagePath.startsWith(`${scope.wholesalerId}/`)) {
    return { success: false, error: "저장 경로가 올바르지 않습니다." };
  }

  const fileName = input.fileName.trim();

  if (!fileName || fileName.length > 255) {
    return { success: false, error: "파일 이름을 확인해주세요." };
  }

  if (input.statementDate && !DATE_PATTERN.test(input.statementDate)) {
    return { success: false, error: "거래일 형식이 올바르지 않습니다." };
  }

  const memo = input.memo?.trim() || null;

  if (memo && memo.length > 500) {
    return { success: false, error: "메모는 500자 이하로 적어주세요." };
  }

  const supabase = await createClient();

  const { error } = await supabase.from("supplier_statement_files").insert({
    wholesaler_id: scope.wholesalerId,
    supplier_id: input.supplierId || null,
    statement_date: input.statementDate || null,
    memo,
    file_name: fileName,
    mime_type: input.mimeType || null,
    size_bytes: input.sizeBytes,
    storage_path: input.storagePath,
    uploaded_by: scope.userId,
  });

  if (error) {
    console.error("[Statement File Insert]", error.message);
    return { success: false, error: "명세서 정보를 저장하지 못했습니다. 잠시 후 다시 시도해주세요." };
  }

  revalidatePath("/dashboard/inbound/statements");
  return { success: true };
}

/** 원본을 그대로 내려받는 임시 주소(60초). 열람 권한은 목록 조회(RLS)와 같다. */
export async function getStatementFileUrlAction(id: string): Promise<ActionResult> {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    return { success: false, error: "공급사 정보를 찾을 수 없습니다." };
  }

  const supabase = await createClient();

  const { data: row } = await supabase
    .from("supplier_statement_files")
    .select("storage_path, file_name")
    .eq("id", id)
    .eq("wholesaler_id", scope.wholesalerId)
    .maybeSingle();

  if (!row) {
    return { success: false, error: "파일을 찾을 수 없습니다." };
  }

  const { data, error } = await supabase.storage
    .from(STATEMENT_BUCKET)
    .createSignedUrl(row.storage_path as string, 60, { download: row.file_name as string });

  if (error || !data?.signedUrl) {
    return { success: false, error: "파일을 열지 못했습니다. 잠시 후 다시 시도해주세요." };
  }

  return { success: true, url: data.signedUrl };
}

/** 목록에서만 감춘다. 파일과 기록은 지우지 않는다(owner·manager만, DB가 강제). */
export async function hideStatementFileAction(id: string): Promise<ActionResult> {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    return { success: false, error: "공급사 정보를 찾을 수 없습니다." };
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("supplier_statement_files")
    .update({ hidden_at: new Date().toISOString(), hidden_by: scope.userId })
    .eq("id", id)
    .eq("wholesaler_id", scope.wholesalerId)
    .is("hidden_at", null)
    .select("id");

  if (error) {
    console.error("[Statement File Hide]", error.message);
    return { success: false, error: "숨기지 못했습니다. 잠시 후 다시 시도해주세요." };
  }

  if (!data || data.length === 0) {
    return { success: false, error: "숨길 수 없는 파일이거나 권한이 없습니다. (사장·매니저만 숨길 수 있습니다)" };
  }

  revalidatePath("/dashboard/inbound/statements");
  return { success: true };
}
