"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { extractExcelTable } from "@/lib/livestock/excel-table";
import { fetchSubcategoriesByCategory } from "../products/get-subcategories";
import { composeIdentityName, identityFieldsFor } from "@/lib/products/identity-key";
import { loadProductOptions } from "@/lib/purchase-orders/load-product-options";
import { findProductForSpec, specFromProduct, type ProductOption } from "@/lib/purchase-orders/product-match";
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

/** 줄들에 나온 축종 중 상품 정체성 키가 있는 것 — 스펙으로 상품을 찾을 수 있는 축종만 미리 읽어 두면 된다. */
function keyCategoriesOf(lines: ReadonlyArray<{ category: string }>): string[] {
  return [...new Set(lines.map((line) => (line.category ?? "").trim()).filter((category) => identityFieldsFor(category) !== null))];
}

/** 엑셀(.xlsx)을 읽어 화면에 채울 줄을 돌려준다. 저장은 하지 않는다 — 화면에서 확인·수정한 뒤 저장한다. */
export async function parsePurchaseOrderFileAction(
  formData: FormData
): Promise<ActionResult<{ rows: ParsedUploadRow[] }>> {
  try {
    const { supabase, wholesalerId } = await resolveScope();
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

    // 오류 없는 줄은 등록된 상품과 스펙으로 맞춰 본다 — 맞는 상품이 있으면 화면에서 고른 것과 똑같이 연결된다.
    // 줄에 나온 키 축종의 상품만 읽는다(상품이 수천 개여도 필요한 만큼만).
    const products = await loadProductOptions(supabase, wholesalerId, { categories: keyCategoriesOf(parsed.rows.filter((row) => !row.error).map((row) => row.input)) });

    for (const row of parsed.rows) {
      if (!row.error) {
        row.input.productId = findProductForSpec(row.input, products)?.id ?? "";
      }
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

export async function createPurchaseOrderAction(input: CreatePurchaseOrderInput): Promise<ActionResult<{ id: string; createdProducts: number }>> {
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

    const linkedIds = input.lines.map((line) => line.productId).filter((id): id is string => Boolean(id));

    if (linkedIds.some((id) => !UUID_PATTERN.test(id))) {
      throw new RbacError("선택한 품목을 찾을 수 없습니다. 다시 골라주세요.");
    }

    // 고른 상품은 그 상품만, 스펙만 적은 줄은 그 줄의 키 축종 상품만 읽는다(상품이 수천 개여도 필요한 만큼만).
    const [categories, subcategories, linkedProducts, sameCategoryProducts] = await Promise.all([
      loadCategoryNames(supabase),
      fetchSubcategoriesByCategory(supabase),
      linkedIds.length > 0 ? loadProductOptions(supabase, wholesalerId, { ids: linkedIds }) : Promise.resolve([] as ProductOption[]),
      loadProductOptions(supabase, wholesalerId, { categories: keyCategoriesOf(input.lines.filter((line) => !line.productId)) }),
    ]);
    const products = [...new Map([...linkedProducts, ...sameCategoryProducts].map((product) => [product.id, product])).values()];
    const productById = new Map(products.map((product) => [product.id, product]));
    const createdProductIds = new Set<string>();
    const validated: Array<ReturnType<typeof validatePurchaseOrderLine> extends infer R ? (R extends { ok: true; line: infer L } ? L & { productId: string } : never) : never> = [];

    for (const [index, line] of input.lines.entries()) {
      const linked = line.productId ? productById.get(line.productId) : undefined;

      if (line.productId && !linked) {
        throw new RbacError(`${index + 1}번째 줄: 선택한 품목을 찾을 수 없습니다(보관됐거나 삭제됨). 다시 골라주세요.`);
      }

      // 상품을 고른 줄은 스펙을 상품에서 가져온다(화면이 보낸 값은 믿지 않는다). 안 고른 줄은 스펙을 검사하고 같은 상품이 있으면 잇는다.
      const result = validatePurchaseOrderLine(
        linked ? { ...line, ...specFromProduct(linked) } : line,
        categories,
        subcategories,
        { trustSpec: Boolean(linked) }
      );

      if (!result.ok) {
        throw new RbacError(`${index + 1}번째 줄: ${result.error}`);
      }

      let matched = linked ?? findProductForSpec({ ...result.line, breed: result.line.breed ?? "", subcategory: result.line.subcategory ?? "", grade: result.line.grade ?? "" }, products);

      // 발주서의 모든 줄은 등록된 품목이어야 한다(입고 때 박스를 이 줄과 이으려면 상품이 필요하다). 화면으로 넣든 엑셀로 올리든 기준이 같고,
      // 등록된 품목이 없는 줄은 튕기지 않고 상품 관리에 판매중지·0원으로 자동 등록해 잇는다(사장님 결정, 2026-09-28).
      // 같은 발주서에서 같은 스펙이 여러 줄이면 첫 줄이 만든 상품을 다음 줄이 그대로 쓴다(products에 만든 상품을 보태 둔다).
      if (!matched) {
        try {
          const ensured = await ensureProductForSpec(
            supabase,
            wholesalerId,
            {
              category: result.line.category,
              breed: result.line.breed ?? "",
              subcategory: result.line.subcategory ?? "",
              grade: result.line.grade ?? "",
              origin: result.line.origin,
              name: result.line.subcategory ?? "",
            },
            products
          );

          matched = ensured.product;

          if (ensured.created) {
            products.push(ensured.product);
            createdProductIds.add(ensured.product.id);
          }
        } catch (error) {
          throw new RbacError(`${index + 1}번째 줄: ${error instanceof Error ? error.message : "품목을 등록하지 못했습니다."}`);
        }
      }

      validated.push({ ...result.line, productId: matched.id });
    }

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
        breed: line.breed,
        subcategory: line.subcategory,
        grade: line.grade,
        origin: line.origin,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        product_id: line.productId,
      }))
    );

    if (linesError) {
      // 줄 없는 빈 발주서가 남지 않게 헤더를 지운다(줄은 FK CASCADE).
      await supabase.from("purchase_orders").delete().eq("id", order.id);
      throw new Error(linesError.message);
    }

    revalidatePath(REVALIDATE_PATH);

    if (createdProductIds.size > 0) {
      revalidatePath("/dashboard/products");
    }

    return { success: true, data: { id: order.id as string, createdProducts: createdProductIds.size } };
  } catch (error) {
    return toResult(error);
  }
}

interface ProductSpecInput {
  category: string;
  breed: string;
  subcategory: string;
  grade: string;
  origin: string;
  /** 정체성 키가 없는 축종(양·가공육)만 — 키 축종은 이름이 자동으로 조합된다. */
  name: string;
}

/**
 * 스펙에 맞는 상품을 돌려준다. 이미 있으면 그걸, 없으면 상품 관리에 판매중지·0원으로 새로 등록한다(가격을 넣고 켜야 고객에게 보인다).
 * known은 이미 읽어 둔 같은 축종의 상품 목록이다.
 */
async function ensureProductForSpec(
  supabase: Awaited<ReturnType<typeof createClient>>,
  wholesalerId: string,
  spec: ProductSpecInput,
  known: readonly ProductOption[]
): Promise<{ product: ProductOption; created: boolean }> {
  const fields = identityFieldsFor(spec.category);
  const name = fields ? (composeIdentityName(spec.category, spec.subcategory, spec.grade, spec.breed) ?? spec.category) : spec.name.trim();

  if (fields?.includes("subcategory") && !spec.subcategory) {
    throw new RbacError("부위를 골라주세요.");
  }

  if (fields?.includes("grade") && !spec.grade) {
    throw new RbacError("등급을 골라주세요.");
  }

  if (!fields && name.length < 2) {
    throw new RbacError("상품명을 2자 이상 입력해주세요.");
  }

  const existing = fields ? findProductForSpec(spec, known) : known.find((product) => product.category === spec.category && product.name === name && product.origin === spec.origin);

  if (existing) {
    return { product: existing, created: false };
  }

  const { data, error } = await supabase
    .from("products")
    .insert({
      wholesaler_id: wholesalerId,
      name,
      category: spec.category,
      subcategory: spec.subcategory || null,
      grade: spec.grade || null,
      breed: spec.category === "소" ? spec.breed : null,
      origin: spec.origin,
      base_price: 0,
      unit: "kg",
      stock_quantity: 0,
      is_active: false,
      description: "발주서 작성 중 등록됨 — 판매가를 넣고 판매중으로 바꾸면 고객에게 보입니다.",
    })
    .select("id, name, category, subcategory, grade, breed, origin")
    .single();

  if (error?.code === "23505") {
    // 같은 상품을 동시에 만들던 다른 요청이 먼저 만들었다 — 그 상품을 쓴다.
    const again = fields ? findProductForSpec(spec, await loadProductOptions(supabase, wholesalerId, { categories: [spec.category] })) : null;

    if (again) {
      return { product: again, created: false };
    }
  }

  if (error || !data) {
    throw new Error(error?.message ?? "상품 등록에 실패했습니다.");
  }

  return { product: data as ProductOption, created: true };
}

export type CreatePurchaseOrderProductInput = ProductSpecInput;

/** 발주서를 쓰다가 목록에 없는 품목을 그 자리에서 상품 관리에 등록한다(화면의 "새 품목 만들기"). 같은 상품이 이미 있으면 그 상품을 돌려준다. */
export async function createPurchaseOrderProductAction(
  input: CreatePurchaseOrderProductInput
): Promise<ActionResult<{ product: ProductOption; created: boolean }>> {
  try {
    const { supabase, wholesalerId } = await resolveScope();
    const [categories, subcategories] = await Promise.all([loadCategoryNames(supabase), fetchSubcategoriesByCategory(supabase)]);
    const products = await loadProductOptions(supabase, wholesalerId, { categories: [(input.category ?? "").trim()] });
    const spec = {
      category: (input.category ?? "").trim(),
      breed: (input.breed ?? "").trim(),
      subcategory: (input.subcategory ?? "").trim(),
      grade: (input.grade ?? "").trim(),
      origin: (input.origin ?? "").trim(),
      name: (input.name ?? "").trim(),
    };
    const checked = validatePurchaseOrderLine({ ...spec, quantity: "1", unitPrice: "" }, categories, subcategories);

    if (!checked.ok) {
      throw new RbacError(checked.error);
    }

    const ensured = await ensureProductForSpec(supabase, wholesalerId, spec, products);

    if (ensured.created) {
      revalidatePath("/dashboard/products");
    }

    return { success: true, data: ensured };
  } catch (error) {
    return toResult(error);
  }
}

const NEXT_STATUS = { close: "CLOSED", cancel: "CANCELLED", reopen: "OPEN" } as const;

/** 발주서 상태 — 발주강제종결(사람이 손으로 닫음)·취소·다시 열기. 물건을 받은 기록은 지우지 않는다(상태만 바뀐다). */
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
