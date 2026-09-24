"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

/** 세트 구성(BOM)은 상품 마스터를 건드리는 일이라 manager 이상이다. */
const BUNDLE_EDIT_ROLES: OrgRole[] = ["owner", "manager"];

/** 세트 제작은 창고에서 실제로 박스를 싸는 현장 작업이라 staff까지 허용한다. */
const BUNDLE_WORK_ROLES: OrgRole[] = ["owner", "manager", "staff"];

const REVALIDATE_PATHS = ["/dashboard/bundles", "/dashboard/products", "/dashboard/stock-ledger"];

function revalidateAll() {
  for (const path of REVALIDATE_PATHS) {
    revalidatePath(path);
  }
}

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/** DB가 던지는 코드를 사람 말로 바꾼다. 코드 그대로 보여주면 현장에서 못 읽는다. */
function describeBundleError(message: string): string {
  const shortage = message.match(/INSUFFICIENT_COMPONENT_BOXES:([^:]+):([\d.]+):([\d.]+)/);

  if (shortage) {
    return (
      `'${shortage[1]}'의 입고 박스가 부족합니다 (쓸 수 있는 양 ${shortage[2]}kg / 필요 ${shortage[3]}kg). ` +
      "유통기한이 지난 박스와 이력번호가 없는 재고는 세트에 넣지 않습니다."
    );
  }

  const nested = message.match(/NESTED_BUNDLE:(.+)/);

  if (nested) {
    return `'${nested[1]}'은(는) 이미 세트 상품입니다. 세트를 세트 안에 넣을 수 없습니다.`;
  }

  const sourceGone = message.match(/SOURCE_BOX_UNAVAILABLE:(.+)/);

  if (sourceGone) {
    return `구성 박스(${sourceGone[1]})가 이미 처리돼 되돌릴 수 없습니다.`;
  }

  if (message.includes("PRODUCT_HAS_STOCK_HISTORY")) {
    return "입출고 기록이 있는 상품은 세트 상품으로 지정할 수 없습니다. 세트용 상품을 새로 만들어주세요.";
  }

  const manualStock = message.match(/PRODUCT_HAS_MANUAL_STOCK:([\d.]+)/);

  if (manualStock) {
    return (
      `이 상품에 수동으로 입력된 재고(${String(Number(manualStock[1]))})가 남아 있습니다. ` +
      "세트는 제작한 박스로만 재고가 잡혀야 하므로, 상품관리에서 재고를 0으로 맞춘 뒤 다시 지정해주세요."
    );
  }

  const archivedComponent = message.match(/COMPONENT_ARCHIVED:(.+)/);

  if (archivedComponent) {
    return `구성품 '${archivedComponent[1]}'이(가) 보관 처리돼 있어 세트를 만들 수 없습니다. 보관을 풀거나 구성에서 빼주세요.`;
  }

  if (message.includes("ALREADY_A_BUNDLE")) {
    return "이미 세트로 등록된 상품입니다.";
  }

  if (message.includes("COMPONENT_CANNOT_BE_BUNDLE")) {
    return "다른 세트의 구성품으로 쓰이는 상품은 세트 상품이 될 수 없습니다.";
  }

  if (message.includes("BUNDLE_HAS_ASSEMBLIES")) {
    return "이미 제작한 세트가 있어 구성을 지울 수 없습니다. 역추적 근거가 사라지기 때문입니다.";
  }

  if (message.includes("BUNDLE_HAS_NO_ITEMS")) {
    return "구성품을 하나 이상 넣어주세요.";
  }

  if (message.includes("COMPONENT_NOT_FOUND")) {
    return "구성품으로 고른 상품을 찾을 수 없습니다.";
  }

  if (message.includes("INVALID_COMPONENT_QUANTITY")) {
    return "구성품 소요량을 0보다 크게 입력해주세요.";
  }

  if (message.includes("SELF_COMPONENT")) {
    return "세트 상품 자신을 구성품으로 넣을 수 없습니다.";
  }

  if (message.includes("PARTIALLY_SHIPPED")) {
    return "이미 출고된 세트는 해체할 수 없습니다.";
  }

  if (message.includes("ALREADY_VOIDED")) {
    return "이미 해체된 세트입니다.";
  }

  if (message.includes("NAME_REQUIRED")) {
    return "세트 상품 이름을 입력해주세요.";
  }

  if (message.includes("INVALID_SET_COUNT")) {
    return "제작 수량은 1~200 사이로 입력해주세요.";
  }

  return message;
}

export interface BundleItemInput {
  productId: string;
  quantity: number;
}

/** 세트 구성(BOM) 저장. bundleId가 없고 productId도 없으면 세트 상품을 새로 만든다. */
export async function saveBundleAction(input: {
  items: BundleItemInput[];
  bundleId?: string | null;
  productId?: string | null;
  name?: string | null;
  basePrice?: number | null;
  bundleCode?: string | null;
  memo?: string | null;
}): Promise<ActionResult<{ bundleId: string; bundleCode: string; created: boolean }>> {
  try {
    await requireOrgRole(BUNDLE_EDIT_ROLES);

    if (input.items.length === 0) {
      throw new RbacError("구성품을 하나 이상 넣어주세요.");
    }

    const supabase = await createClient();

    const { data, error } = await supabase.rpc("save_product_bundle", {
      p_items: input.items.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
      })),
      p_bundle_id: input.bundleId ?? null,
      p_product_id: input.productId ?? null,
      p_name: input.name ?? null,
      p_base_price: input.basePrice ?? null,
      p_bundle_code: input.bundleCode ?? null,
      p_memo: input.memo ?? null,
    });

    if (error) {
      throw new RbacError(describeBundleError(error.message));
    }

    revalidateAll();

    const row = (data ?? {}) as Record<string, unknown>;

    return {
      success: true,
      data: {
        bundleId: String(row.bundle_id),
        bundleCode: String(row.bundle_code ?? ""),
        created: Boolean(row.created),
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

export async function deleteBundleAction(bundleId: string): Promise<ActionResult> {
  try {
    await requireOrgRole(BUNDLE_EDIT_ROLES);

    const supabase = await createClient();
    const { error } = await supabase.rpc("delete_product_bundle", { p_bundle_id: bundleId });

    if (error) {
      throw new RbacError(describeBundleError(error.message));
    }

    revalidateAll();

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

export interface AssembledSet {
  assemblyId: string;
  setNo: string;
  totalWeight: number;
  bestBefore: string | null;
  sources: number;
}

/** 세트 제작 — 구성품 박스에서 선입선출로 빼고 세트 박스를 만든다. */
export async function assembleBundleAction(
  bundleId: string,
  setCount: number
): Promise<ActionResult<{ sets: AssembledSet[]; buildable: number }>> {
  try {
    await requireOrgRole(BUNDLE_WORK_ROLES);

    const supabase = await createClient();

    const { data, error } = await supabase.rpc("assemble_product_bundle", {
      p_bundle_id: bundleId,
      p_set_count: setCount,
    });

    if (error) {
      throw new RbacError(describeBundleError(error.message));
    }

    revalidateAll();

    const row = (data ?? {}) as Record<string, unknown>;

    return {
      success: true,
      data: {
        buildable: Number(row.buildable ?? 0),
        sets: ((row.sets ?? []) as Array<Record<string, unknown>>).map((set) => ({
          assemblyId: String(set.assembly_id),
          setNo: String(set.set_no),
          totalWeight: Number(set.total_weight),
          bestBefore: (set.best_before as string | null) ?? null,
          sources: Number(set.sources ?? 0),
        })),
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/** 세트 해체 — 구성품을 원래 박스로 되돌린다(역분개). */
export async function disassembleAssemblyAction(assemblyId: string): Promise<ActionResult> {
  try {
    await requireOrgRole(BUNDLE_WORK_ROLES);

    const supabase = await createClient();
    const { error } = await supabase.rpc("disassemble_bundle_assembly", {
      p_assembly_id: assemblyId,
    });

    if (error) {
      throw new RbacError(describeBundleError(error.message));
    }

    revalidateAll();

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

export interface TraceUsageRow {
  traceNo: string;
  setNo: string;
  setProductName: string;
  componentName: string;
  usedWeight: number;
  assemblyStatus: string;
  assembledAt: string;
  orderNumber: string | null;
  retailerName: string | null;
  shippedAt: string | null;
}

/**
 * 이력번호 역추적 — "이 번호가 어느 세트로 묶여 어디로 갔나".
 * 정부 추적 요청이 들어왔을 때 답하는 경로다.
 */
export async function traceBundleUsageAction(
  traceNo: string
): Promise<ActionResult<TraceUsageRow[]>> {
  try {
    await requireOrgRole(BUNDLE_WORK_ROLES);

    const value = traceNo.trim();

    if (!value) {
      throw new RbacError("이력번호를 입력해주세요.");
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("trace_bundle_usage", { p_trace_no: value });

    if (error) {
      throw new Error(error.message);
    }

    return {
      success: true,
      data: ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        traceNo: String(row.trace_no),
        setNo: String(row.set_no),
        setProductName: String(row.set_product_name ?? ""),
        componentName: String(row.component_name ?? ""),
        usedWeight: Number(row.used_weight),
        assemblyStatus: String(row.assembly_status),
        assembledAt: String(row.assembled_at),
        orderNumber: (row.order_number as string | null) ?? null,
        retailerName: (row.retailer_name as string | null) ?? null,
        shippedAt: (row.shipped_at as string | null) ?? null,
      })),
    };
  } catch (error) {
    return toResult(error);
  }
}
