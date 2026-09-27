"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { extractExcelTable } from "@/lib/livestock/excel-table";
import {
  PURCHASE_ORDER_MAX_LINES,
  parsePurchaseOrderCells,
  validatePurchaseOrderLine,
  type ParsedUploadRow,
  type PurchaseOrderLineInput,
} from "@/lib/purchase-orders/lines";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/purchase-orders";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** 발주서 작성·수정은 상품 관리와 같은 기준 — owner/manager (직원은 조회만, DB RLS도 같다). */
const PURCHASE_ORDER_ROLES: OrgRole[] = ["owner", "manager"];

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return { success: false, error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다." };
}

async function resolveScope() {
  const context = await requireOrgRole(PURCHASE_ORDER_ROLES);
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

  if (!wholesalerId) {
    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("id")
      .eq("profile_id", context.userId)
      .maybeSingle();

    wholesalerId = (wholesaler?.id as string | null) ?? null;
  }

  if (!wholesalerId) {
    throw new RbacError("공급사 업체 정보가 없어 발주서를 관리할 수 없습니다.");
  }

  return { supabase, wholesalerId };
}

async function loadCategoryNames(supabase: Awaited<ReturnType<typeof createClient>>): Promise<string[]> {
  const { data } = await supabase.from("product_categories").select("name").order("sort_order", { ascending: true });

  return ((data ?? []) as Array<{ name: string }>).map((row) => row.name);
}

/** 엑셀(.xlsx)을 읽어 화면에 채울 줄을 돌려준다. 저장은 하지 않는다 — 화면에서 확인·수정한 뒤 저장한다. */
export async function parsePurchaseOrderFileAction(
  formData: FormData
): Promise<ActionResult<{ rows: ParsedUploadRow[] }>> {
  try {
    const { supabase } = await resolveScope();
    const file = formData.get("file");

    if (!(file instanceof File) || file.size === 0) {
      throw new RbacError("엑셀 파일(.xlsx)을 골라주세요.");
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      throw new RbacError("파일이 너무 큽니다(5MB 이하).");
    }

    if (!/\.xlsx$/i.test(file.name)) {
      throw new RbacError("엑셀 파일(.xlsx)만 올릴 수 있습니다. 내려받은 양식을 채워 올려주세요.");
    }

    let table;

    try {
      table = await extractExcelTable(Buffer.from(await file.arrayBuffer()));
    } catch {
      throw new RbacError("엑셀 파일을 읽지 못했습니다. 내려받은 양식(.xlsx)을 그대로 채워 올려주세요.");
    }

    const parsed = parsePurchaseOrderCells(table.cells, await loadCategoryNames(supabase));

    if (parsed.headerError) {
      throw new RbacError(parsed.headerError);
    }

    if (parsed.rows.length === 0) {
      throw new RbacError("올릴 줄이 없습니다. 머리글 아래에 발주할 품목을 적어주세요.");
    }

    if (parsed.rows.length > PURCHASE_ORDER_MAX_LINES) {
      throw new RbacError(`한 발주서에는 ${PURCHASE_ORDER_MAX_LINES}줄까지 넣을 수 있습니다.`);
    }

    return { success: true, data: { rows: parsed.rows } };
  } catch (error) {
    return toResult(error);
  }
}

export interface CreatePurchaseOrderInput {
  supplierName: string;
  orderedOn: string;
  expectedOn: string;
  note: string;
  lines: PurchaseOrderLineInput[];
}

export async function createPurchaseOrderAction(input: CreatePurchaseOrderInput): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase, wholesalerId } = await resolveScope();
    const supplierName = (input.supplierName ?? "").trim();
    const note = (input.note ?? "").trim();

    if (!supplierName) {
      throw new RbacError("공급처 이름을 입력해주세요.");
    }

    if (supplierName.length > 80) {
      throw new RbacError("공급처 이름은 80자 이내로 입력해주세요.");
    }

    if (note.length > 500) {
      throw new RbacError("메모는 500자 이내로 입력해주세요.");
    }

    if (!DATE_PATTERN.test(input.orderedOn ?? "")) {
      throw new RbacError("발주일을 입력해주세요.");
    }

    if (input.expectedOn && !DATE_PATTERN.test(input.expectedOn)) {
      throw new RbacError("도착 예정일 형식이 올바르지 않습니다.");
    }

    if (input.expectedOn && input.expectedOn < input.orderedOn) {
      throw new RbacError("도착 예정일은 발주일보다 빠를 수 없습니다.");
    }

    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new RbacError("발주할 품목을 한 줄 이상 입력해주세요.");
    }

    if (input.lines.length > PURCHASE_ORDER_MAX_LINES) {
      throw new RbacError(`한 발주서에는 ${PURCHASE_ORDER_MAX_LINES}줄까지 넣을 수 있습니다.`);
    }

    const categories = await loadCategoryNames(supabase);
    const validated = input.lines.map((line, index) => {
      const result = validatePurchaseOrderLine(line, categories);

      if (!result.ok) {
        throw new RbacError(`${index + 1}번째 줄: ${result.error}`);
      }

      return result.line;
    });

    const { data: order, error: orderError } = await supabase
      .from("purchase_orders")
      .insert({
        wholesaler_id: wholesalerId,
        supplier_name: supplierName,
        ordered_on: input.orderedOn,
        expected_on: input.expectedOn || null,
        note: note || null,
      })
      .select("id")
      .single();

    if (orderError || !order) {
      throw new Error(orderError?.message ?? "발주서 저장에 실패했습니다.");
    }

    const { error: linesError } = await supabase.from("purchase_order_lines").insert(
      validated.map((line, index) => ({
        purchase_order_id: order.id,
        wholesaler_id: wholesalerId,
        line_no: index + 1,
        category: line.category,
        subcategory: line.subcategory,
        grade: line.grade,
        origin: line.origin,
        quantity: line.quantity,
        unit_price: line.unitPrice,
      }))
    );

    if (linesError) {
      // 줄 없는 빈 발주서가 남지 않게 헤더를 지운다(줄은 FK CASCADE).
      await supabase.from("purchase_orders").delete().eq("id", order.id);
      throw new Error(linesError.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: order.id as string } };
  } catch (error) {
    return toResult(error);
  }
}

const NEXT_STATUS = { close: "CLOSED", cancel: "CANCELLED", reopen: "OPEN" } as const;

/** 발주서 상태 — 마감(다 받음)·취소·다시 열기. 물건을 받은 기록은 지우지 않는다(상태만 바뀐다). */
export async function setPurchaseOrderStatusAction(
  purchaseOrderId: string,
  action: keyof typeof NEXT_STATUS
): Promise<ActionResult> {
  try {
    const { supabase, wholesalerId } = await resolveScope();

    if (!UUID_PATTERN.test(purchaseOrderId) || !(action in NEXT_STATUS)) {
      throw new RbacError("올바른 요청이 아닙니다.");
    }

    const { data, error } = await supabase
      .from("purchase_orders")
      .update({ status: NEXT_STATUS[action] })
      .eq("id", purchaseOrderId)
      .eq("wholesaler_id", wholesalerId)
      .select("id")
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      throw new RbacError("권한이 없거나 해당 발주서를 찾을 수 없습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}
