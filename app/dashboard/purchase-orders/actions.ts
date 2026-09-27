"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { extractExcelTable } from "@/lib/livestock/excel-table";
import { fetchSubcategoriesByCategory } from "../products/get-subcategories";
import {
  PURCHASE_ORDER_MAX_LINES,
  parsePurchaseOrderCells,
  validatePurchaseOrderLine,
  type ParsedUploadRow,
  type PurchaseOrderLineInput,
} from "@/lib/purchase-orders/lines";
import {
  findSupplierCollision,
  validateSupplierInput,
  type SupplierFormInput,
  type SupplierNameEntry,
} from "@/lib/purchase-orders/suppliers";

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

    const [categoryNames, subcategories] = await Promise.all([loadCategoryNames(supabase), fetchSubcategoriesByCategory(supabase)]);
    const parsed = parsePurchaseOrderCells(table.cells, categoryNames, subcategories);

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
  supplierId: string;
  orderedOn: string;
  expectedOn: string;
  note: string;
  lines: PurchaseOrderLineInput[];
}

export async function createPurchaseOrderAction(input: CreatePurchaseOrderInput): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase, wholesalerId } = await resolveScope();
    const note = (input.note ?? "").trim();

    if (!UUID_PATTERN.test(input.supplierId ?? "")) {
      throw new RbacError("공급처를 목록에서 골라주세요.");
    }

    const { data: supplier } = await supabase
      .from("suppliers")
      .select("id, name, is_active")
      .eq("id", input.supplierId)
      .eq("wholesaler_id", wholesalerId)
      .maybeSingle();

    if (!supplier) {
      throw new RbacError("선택한 공급처를 찾을 수 없습니다. 거래처 목록에서 다시 골라주세요.");
    }

    if (!supplier.is_active) {
      throw new RbacError("사용을 중지한 거래처입니다. 거래처를 다시 사용으로 바꾸거나 다른 거래처를 고르세요.");
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

    const [categories, subcategories] = await Promise.all([loadCategoryNames(supabase), fetchSubcategoriesByCategory(supabase)]);
    const validated = input.lines.map((line, index) => {
      const result = validatePurchaseOrderLine(line, categories, subcategories);

      if (!result.ok) {
        throw new RbacError(`${index + 1}번째 줄: ${result.error}`);
      }

      return result.line;
    });

    const { data: order, error: orderError } = await supabase
      .from("purchase_orders")
      .insert({
        wholesaler_id: wholesalerId,
        supplier_id: supplier.id,
        supplier_name: supplier.name,
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

// ====================================================================
// 거래처(공급처) 관리 — 발주서 화면 안에서 쓴다(마이그레이션 136)
// ====================================================================
async function loadSupplierNames(supabase: Awaited<ReturnType<typeof createClient>>, wholesalerId: string): Promise<SupplierNameEntry[]> {
  const { data } = await supabase.from("suppliers").select("id, name, aliases").eq("wholesaler_id", wholesalerId);

  return ((data ?? []) as Array<{ id: string; name: string; aliases: string[] | null }>).map((row) => ({
    id: row.id,
    name: row.name,
    aliases: row.aliases ?? [],
  }));
}

export async function createSupplierAction(input: SupplierFormInput): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    const { supabase, wholesalerId } = await resolveScope();
    const validation = validateSupplierInput(input);

    if (!validation.ok) {
      throw new RbacError(validation.error);
    }

    const collision = findSupplierCollision(validation.value, await loadSupplierNames(supabase, wholesalerId));

    if (collision) {
      throw new RbacError(collision);
    }

    const { data, error } = await supabase
      .from("suppliers")
      .insert({ wholesaler_id: wholesalerId, ...validation.value })
      .select("id, name")
      .single();

    if (error || !data) {
      // 동시에 같은 이름을 등록한 경우 — DB 유니크 인덱스가 마지막으로 막는다.
      throw new RbacError(error?.code === "23505" ? "이미 같은 이름의 거래처가 있습니다." : (error?.message ?? "거래처 저장에 실패했습니다."));
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: data.id as string, name: data.name as string } };
  } catch (error) {
    return toResult(error);
  }
}

export async function updateSupplierAction(supplierId: string, input: SupplierFormInput): Promise<ActionResult> {
  try {
    const { supabase, wholesalerId } = await resolveScope();

    if (!UUID_PATTERN.test(supplierId)) {
      throw new RbacError("올바른 거래처가 아닙니다.");
    }

    const validation = validateSupplierInput(input);

    if (!validation.ok) {
      throw new RbacError(validation.error);
    }

    const collision = findSupplierCollision(validation.value, await loadSupplierNames(supabase, wholesalerId), supplierId);

    if (collision) {
      throw new RbacError(collision);
    }

    const { data, error } = await supabase
      .from("suppliers")
      .update(validation.value)
      .eq("id", supplierId)
      .eq("wholesaler_id", wholesalerId)
      .select("id")
      .maybeSingle();

    if (error) {
      throw new RbacError(error.code === "23505" ? "이미 같은 이름의 거래처가 있습니다." : error.message);
    }

    if (!data) {
      throw new RbacError("권한이 없거나 해당 거래처를 찾을 수 없습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

/** 거래처는 지우지 않고 사용 중지한다 — 지난 발주서가 이 거래처를 가리키고 있다. 중지하면 새 발주서의 선택 목록에서만 빠진다. */
export async function setSupplierActiveAction(supplierId: string, active: boolean): Promise<ActionResult> {
  try {
    const { supabase, wholesalerId } = await resolveScope();

    if (!UUID_PATTERN.test(supplierId)) {
      throw new RbacError("올바른 거래처가 아닙니다.");
    }

    const { data, error } = await supabase
      .from("suppliers")
      .update({ is_active: active })
      .eq("id", supplierId)
      .eq("wholesaler_id", wholesalerId)
      .select("id")
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      throw new RbacError("권한이 없거나 해당 거래처를 찾을 수 없습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}
