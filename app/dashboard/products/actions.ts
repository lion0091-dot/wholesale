"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { DEFAULT_DELIVERY_ITEMS } from "@/lib/products/default-delivery-items";
import { STOCK_ADJUST_REASON_CODES } from "@/lib/products/stock-adjust-reasons";
import { composeIdentityName, IDENTITY_FIELD_LABELS, identityFieldsFor } from "@/lib/products/identity-key";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/products";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 상품 관리 권한 — PRD 기준 manager 이상 (staff는 발주 처리만) */
const PRODUCT_ROLES: OrgRole[] = ["owner", "manager"];

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/**
 * 상품은 레거시 wholesalers.id로 스코프된다.
 * 조직에 연결된 wholesaler_id를 우선 사용하고, 없으면 본인 profile로 조회한다.
 */
async function resolveProductScope() {
  const context = await requireOrgRole(PRODUCT_ROLES);
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
    throw new RbacError("공급사 업체 정보가 없어 상품을 관리할 수 없습니다.");
  }

  return { supabase, context, wholesalerId };
}

interface ProductInput {
  name: string;
  category: string;
  subcategory: string | null;
  origin: string;
  grade: string | null;
  base_price: number;
  unit: string;
  stock_quantity: number;
  is_active: boolean;
  description: string | null;
  hot_deal_active: boolean;
  hot_deal_price: number | null;
  hot_deal_quantity_limit: number | null;
  hot_deal_quota_alert_threshold: number | null;
  /** "none"이면 발주정지 상태를 건드리지 않는다 — 폼이 로드된 뒤 DB에서(예: 자동정지) 먼저 바뀐 값을 덮어쓰지 않기 위함. */
  order_stopped_action: "none" | "stop" | "resume";
}

/** 폼 입력 검증. 원매가(purchase_price)는 DB 컬럼이 없어 저장하지 않는다(마진 계산 참고용). */
function parseProductForm(formData: FormData, options: { requireIdentityFields: boolean }): ProductInput {
  const rawName = ((formData.get("name") as string) || "").trim();
  const category = ((formData.get("category") as string) || "").trim();
  const subcategory = ((formData.get("subcategory") as string) || "").trim() || null;
  const origin = ((formData.get("origin") as string) || "").trim();
  const grade = ((formData.get("grade") as string) || "").trim() || null;
  // 키 규칙이 있는 축종(소)은 상품명을 사용자가 적지 않는다 — 부위+등급으로 서버가 만든다(identity-key.ts).
  const identityName = composeIdentityName(category, subcategory, grade);
  const name = identityName ?? rawName;
  const unit = ((formData.get("unit") as string) || "kg").trim();
  // 화면에서 천 단위 콤마를 붙여 표시하므로("25,000") 서버에서 항상 콤마를 제거하고 파싱한다.
  const basePrice = Number.parseFloat(((formData.get("base_price") as string) || "").replace(/,/g, ""));
  const stockQuantity = Number.parseFloat((formData.get("stock_quantity") as string) || "0");
  const description = ((formData.get("description") as string) || "").trim() || null;
  const hotDealActive = formData.get("hot_deal_active") === "on";
  // 핫딜을 꺼도 할인가 자체는 지워지지 않는다(재입고 시 다시 켜기 편하도록) — 폼도 항상 값을 실어 보낸다.
  const hotDealPriceRaw = ((formData.get("hot_deal_price") as string) || "").replace(/,/g, "");
  const hotDealPrice = hotDealPriceRaw ? Number.parseFloat(hotDealPriceRaw) : null;
  const hotDealQuantityLimitRaw = ((formData.get("hot_deal_quantity_limit") as string) || "").trim();
  const hotDealQuantityLimit = hotDealQuantityLimitRaw ? Number.parseFloat(hotDealQuantityLimitRaw) : null;
  const hotDealQuotaAlertThresholdRaw = ((formData.get("hot_deal_quota_alert_threshold") as string) || "").trim();
  const hotDealQuotaAlertThreshold = hotDealQuotaAlertThresholdRaw
    ? Number.parseFloat(hotDealQuotaAlertThresholdRaw)
    : null;
  const orderStoppedActionRaw = (formData.get("order_stopped_action") as string) || "none";
  const orderStoppedAction: ProductInput["order_stopped_action"] =
    orderStoppedActionRaw === "stop" || orderStoppedActionRaw === "resume" ? orderStoppedActionRaw : "none";

  if (identityName === null && name.length < 2) {
    throw new RbacError("상품명을 2자 이상 입력해주세요.");
  }

  if (!category) {
    throw new RbacError("카테고리(부위 구분)를 선택해주세요.");
  }

  // 키 축종은 부위·등급이 키의 일부라 신규 등록에서는 비워둘 수 없다(원산지는 아래에서 공통으로 검사).
  // 수정에서는 요구하지 않는다 — 이력으로 자동 생성된 "(부위 미지정)" 상품의 가격만 고치는 경우가 있어서다.
  const identityValues = { subcategory, grade } as const;

  for (const field of options.requireIdentityFields ? (identityFieldsFor(category) ?? []) : []) {
    if (field !== "origin" && !identityValues[field]) {
      throw new RbacError(
        `${category}는 ${IDENTITY_FIELD_LABELS[field]}을(를) 입력해주세요. 축종·부위·등급·원산지가 이 상품의 정체성입니다.`
      );
    }
  }

  if (!origin) {
    throw new RbacError("원산지를 입력해주세요.");
  }

  if (!Number.isFinite(basePrice) || basePrice < 0) {
    throw new RbacError("기본 단가는 0 이상의 숫자여야 합니다.");
  }

  if (!Number.isFinite(stockQuantity) || stockQuantity < 0) {
    throw new RbacError("재고 수량은 0 이상의 숫자여야 합니다.");
  }

  if (hotDealActive && (hotDealPrice === null || !Number.isFinite(hotDealPrice) || hotDealPrice < 0)) {
    throw new RbacError("핫딜을 켜려면 할인가를 입력해주세요.");
  }

  if (hotDealQuantityLimit !== null && (!Number.isFinite(hotDealQuantityLimit) || hotDealQuantityLimit <= 0)) {
    throw new RbacError("핫딜 판매 한도는 0보다 큰 숫자여야 합니다.");
  }

  if (
    hotDealQuotaAlertThreshold !== null &&
    (!Number.isFinite(hotDealQuotaAlertThreshold) || hotDealQuotaAlertThreshold < 0)
  ) {
    throw new RbacError("임박 알림 기준은 0 이상의 숫자여야 합니다.");
  }

  return {
    name,
    category,
    subcategory,
    origin,
    grade,
    base_price: basePrice,
    unit,
    stock_quantity: stockQuantity,
    is_active: formData.get("is_active") !== "off",
    description,
    hot_deal_active: hotDealActive,
    hot_deal_price: hotDealPrice,
    hot_deal_quantity_limit: hotDealQuantityLimit,
    hot_deal_quota_alert_threshold: hotDealQuotaAlertThreshold,
    order_stopped_action: orderStoppedAction,
  };
}

/**
 * 같은 정체성 키의 상품이 이미 있으면 거부한다(키 규칙이 있는 축종만 — identity-key.ts).
 * 보관된 상품도 대상이다: 같은 상품을 새로 만들지 말고 복원해서 쓰게 안내한다.
 * DB 유니크 제약은 아직 없다 — 이미 있는 중복을 정리한 뒤에 걸어야 해서다(동시 등록 두 건은 이 검사를 함께 통과할 수 있음).
 */
async function assertNoDuplicateIdentity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  wholesalerId: string,
  key: { category: string; subcategory: string | null; grade: string | null; origin: string },
  excludeProductId?: string
): Promise<void> {
  const fields = identityFieldsFor(key.category);

  if (!fields) {
    return;
  }

  let query = supabase
    .from("products")
    .select("id, name, archived_at")
    .eq("wholesaler_id", wholesalerId)
    .eq("category", key.category);

  for (const field of fields) {
    const value = key[field];

    query = value === null ? query.is(field, null) : query.eq(field, value);
  }

  if (excludeProductId) {
    query = query.neq("id", excludeProductId);
  }

  const { data, error } = await query.limit(1);

  if (error) {
    throw new Error(error.message);
  }

  const duplicate = data?.[0];

  if (duplicate) {
    throw new RbacError(
      duplicate.archived_at
        ? `보관된 같은 상품이 있습니다(${duplicate.name}). 새로 만들지 말고 보관 목록에서 복원해서 쓰세요.`
        : `이미 같은 상품이 등록되어 있습니다(${duplicate.name}). ${key.category}은(는) 축종·부위·등급·원산지가 같으면 같은 상품입니다.`
    );
  }
}

// ====================================================================
// 1. 상품 등록
// ====================================================================
export async function createProductAction(
  formData: FormData
): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase, wholesalerId } = await resolveProductScope();
    const { order_stopped_action: _orderStoppedAction, ...input } = parseProductForm(formData, {
      requireIdentityFields: true,
    });

    await assertNoDuplicateIdentity(supabase, wholesalerId, input);

    const { data, error } = await supabase
      .from("products")
      .insert({ wholesaler_id: wholesalerId, ...input })
      .select("id")
      .single();

    if (error || !data) {
      throw new Error(error?.message ?? "상품 등록에 실패했습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: data.id as string } };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 2. 상품 수정
// ====================================================================
export async function updateProductAction(
  productId: string,
  formData: FormData
): Promise<ActionResult> {
  try {
    const { supabase, context, wholesalerId } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    const input = parseProductForm(formData, { requireIdentityFields: false });
    const expectedUpdatedAt = ((formData.get("updated_at") as string) || "").trim();
    // 핫딜을 끌 때 발주정지 자동해제 여부를 판단하는 데만 쓰는 폼 로드 시점 재고 스냅샷
    // (아래 stock_quantity 입력과 달리 사용자가 못 건드리는 hidden 값).
    const stockSnapshotRaw = (formData.get("stock_quantity_snapshot") as string) || "";
    const stockSnapshot = stockSnapshotRaw ? Number.parseFloat(stockSnapshotRaw) : null;
    // 저장 전 hot_deal_active 값 — 이번 저장에서 "핫딜을 껐다"는 전환이 실제로 일어났는지
    // 판단한다. 이게 없으면 원래부터 핫딜을 안 쓰는 일반 상품도 매번 저장할 때마다
    // 수동 발주정지가 조용히 풀린다(hot_deal_active가 항상 false이기 때문).
    const wasHotDealActive = (formData.get("hot_deal_active_snapshot") as string) === "on";

    // 축종/상품명/원산지는 상품 마스터의 정체성 키다 — 이 셋이 같으면 같은 상품으로
    // 취급하므로 등록 후에는 셋 다 변경을 막는다(폼에서도 읽기전용). 셋 중 하나라도
    // 다르면 수정이 아니라 신규 상품 등록으로 유도한다. 단위·기본단가·재고 등
    // 나머지 마스터 값만 여기서 갱신한다.
    // 소유권 확인용 SELECT를 따로 두지 않고, 이 UPDATE 자체에 조직 필터(super_admin은 예외)와
    // updated_at 일치 조건을 함께 걸어 1회 왕복으로 권한 확인·동시편집 충돌 감지·반영을 처리한다.
    // 키 규칙이 있는 축종(소)은 부위·등급도 정체성이라 이미 값이 있으면 못 바꾼다(비어 있던 칸만 한 번 채울 수 있다 —
    // 이력으로 자동 생성된 "(부위 미지정)" 상품에 부위를 채우는 경로). 채우면 상품명도 다시 만든다.
    let subcategoryToSave = input.subcategory;
    let gradeToSave = input.grade;
    let identityName: string | null = null;

    {
      let currentQuery = supabase
        .from("products")
        .select("category, subcategory, grade, origin")
        .eq("id", productId);

      if (!context.isSuperAdmin) {
        currentQuery = currentQuery.eq("wholesaler_id", wholesalerId);
      }

      const { data: current } = await currentQuery.maybeSingle();

      if (current && identityFieldsFor(current.category as string)) {
        const currentPart = (current.subcategory as string | null)?.trim() || null;
        const currentGrade = (current.grade as string | null)?.trim() || null;

        subcategoryToSave = currentPart ?? input.subcategory;
        gradeToSave = currentGrade ?? input.grade;

        if (subcategoryToSave !== currentPart || gradeToSave !== currentGrade) {
          identityName = composeIdentityName(current.category as string, subcategoryToSave, gradeToSave);

          await assertNoDuplicateIdentity(
            supabase,
            wholesalerId,
            {
              category: current.category as string,
              subcategory: subcategoryToSave,
              grade: gradeToSave,
              origin: current.origin as string,
            },
            productId
          );
        }
      }
    }

    const updatePayload: Record<string, unknown> = {
      ...(identityName ? { name: identityName } : {}),
      subcategory: subcategoryToSave,
      grade: gradeToSave,
      base_price: input.base_price,
      unit: input.unit,
      // stock_quantity는 여기서 갱신하지 않는다 — 재고는 stock_ledger 합계로
      // 파생되므로 여기서 덮어쓰면 다음 입고/출고 때 recalc_product_stock()에
      // 의해 조용히 되돌아간다. 수정은 목록의 "재고 조정"(사유 기록)으로만 한다.
      is_active: input.is_active,
      description: input.description,
      hot_deal_active: input.hot_deal_active,
      hot_deal_price: input.hot_deal_price,
      hot_deal_quantity_limit: input.hot_deal_quantity_limit,
      hot_deal_quota_alert_threshold: input.hot_deal_quota_alert_threshold,
      updated_at: new Date().toISOString(),
    };

    // 발주정지는 "건드렸을 때만" 반영한다 — 폼을 열어둔 사이 재고 0으로 자동정지가
    // 걸렸는데 관리자가 이 토글을 만지지 않았다면, 여기서 그 자동정지를 조용히
    // 되돌리면 안 된다(updated_at 낙관적 잠금과 별개의 추가 안전장치).
    if (input.order_stopped_action === "stop") {
      updatePayload.order_stopped = true;
      updatePayload.order_stopped_reason = "manual";
      updatePayload.order_stopped_at = new Date().toISOString();
    } else if (input.order_stopped_action === "resume") {
      updatePayload.order_stopped = false;
      updatePayload.order_stopped_reason = null;
      updatePayload.order_stopped_at = null;
    } else if (
      wasHotDealActive &&
      !input.hot_deal_active &&
      stockSnapshot !== null &&
      stockSnapshot > 0
    ) {
      // "핫딜 오프 = 정상판매 온"이 기본 페어(2026-09-24 확정) — 발주정지 토글을
      // 관리자가 이번 저장에서 직접 만지지 않았어도, 핫딜을 끄면 기본적으로 함께
      // 풀어준다. 단 재고가 여전히 0이면(정상매장 기준으로도 매진) 풀지 않는다.
      // wasHotDealActive로 "이번 저장에서 실제로 껐는지"(전환)만 잡는다 — 그냥
      // hot_deal_active가 false라는 것만 보면, 원래부터 핫딜을 안 쓰는 일반 상품의
      // 수동 발주정지까지 아무 저장에서나 매번 풀려버린다.
      updatePayload.order_stopped = false;
      updatePayload.order_stopped_reason = null;
      updatePayload.order_stopped_at = null;
    }

    let query = supabase.from("products").update(updatePayload).eq("id", productId);

    if (!context.isSuperAdmin) {
      query = query.eq("wholesaler_id", wholesalerId);
    }

    // 폼을 열어둔 사이 목록의 빠른 토글 등으로 다른 곳에서 먼저 저장됐다면 그 변경을
    // 이 폼의(로드 시점 기준) 값으로 덮어쓰지 않고 충돌로 처리한다.
    if (expectedUpdatedAt) {
      query = query.eq("updated_at", expectedUpdatedAt);
    }

    const { data, error } = await query.select("id").maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    // 0건 반영은 상품이 없거나(잘못된 id), 다른 공급사 소유거나, 그 사이 다른 곳에서
    // 먼저 저장돼 updated_at이 어긋난 경우 전부에 해당할 수 있다 — 구분하지 않고 안내한다.
    if (!data) {
      throw new RbacError(
        "상품을 찾을 수 없거나 다른 곳에서 먼저 변경되었습니다. 새로고침 후 다시 시도해주세요."
      );
    }

    revalidatePath(REVALIDATE_PATH);
    revalidatePath(`/dashboard/products/${productId}/edit`);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 3. 판매 상태 토글
// ====================================================================
export async function toggleProductFlagAction(
  productId: string,
  field: "is_active",
  nextValue: boolean
): Promise<ActionResult> {
  try {
    const { supabase, context, wholesalerId } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    if (field !== "is_active") {
      throw new RbacError("변경할 수 없는 항목입니다.");
    }

    let query = supabase
      .from("products")
      .update({ [field]: nextValue, updated_at: new Date().toISOString() })
      .eq("id", productId);

    if (!context.isSuperAdmin) {
      query = query.eq("wholesaler_id", wholesalerId);
    }

    const { data, error } = await query.select("id").maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      throw new RbacError("변경 권한이 없어 저장되지 않았습니다. 새로고침 후 다시 시도해주세요.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 4. 재고 조정 (예전 "재고 수량 변경")
//
// stock_quantity를 직접 UPDATE하면 안 된다 — 재고는 이제 stock_ledger 합계로
// 파생되므로, 덮어쓴 값이 다음 입고/출고 때 recalc_product_stock()에 의해
// 조용히 되돌아간다. 대신 adjust_product_stock() RPC가 차이분을 원장 행으로
// 남기고, 왜 바뀌었는지(실사/폐기/파손/반품)를 함께 기록한다.
// ====================================================================


export async function updateProductStockAction(
  productId: string,
  nextStock: number,
  reasonCode: string,
  reasonNote?: string
): Promise<ActionResult> {
  try {
    const { supabase } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    if (!Number.isFinite(nextStock) || nextStock < 0) {
      throw new RbacError("재고 수량은 0 이상의 숫자여야 합니다.");
    }

    if (!STOCK_ADJUST_REASON_CODES.includes(reasonCode)) {
      throw new RbacError("조정 사유를 선택해주세요.");
    }

    const { error } = await supabase.rpc("adjust_product_stock", {
      p_product_id: productId,
      p_new_quantity: nextStock,
      p_reason_code: reasonCode,
      p_reason_note: reasonNote?.trim() || null,
    });

    if (error) {
      if (error.message.includes("PRODUCT_NOT_FOUND")) {
        throw new RbacError("변경 권한이 없어 저장되지 않았습니다. 새로고침 후 다시 시도해주세요.");
      }

      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 5. 상품 삭제
// ====================================================================
export async function deleteProductAction(productId: string): Promise<ActionResult> {
  try {
    const { supabase, context, wholesalerId } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    // 입출고 기록이 있으면 삭제가 아예 불가능하다 — stock_ledger.product_id가
    // ON DELETE RESTRICT다(입출고 기록은 지우면 안 되는 자료). DB가 막기 전에
    // 먼저 확인해 "보관하세요"라고 안내한다. 그냥 두면 외래키 위반 메시지가
    // 그대로 노출된다.
    const { data: hasHistory } = await supabase.rpc("product_has_stock_history", {
      p_product_id: productId,
    });

    if (hasHistory) {
      throw new RbacError(
        "입출고 기록이 있는 상품은 삭제할 수 없습니다. 기록을 남겨야 하기 때문입니다 — 대신 '보관'으로 목록에서 감출 수 있습니다."
      );
    }

    let query = supabase.from("products").delete().eq("id", productId);

    if (!context.isSuperAdmin) {
      query = query.eq("wholesaler_id", wholesalerId);
    }

    const { data, error } = await query.select("id").maybeSingle();

    if (error) {
      // 23503 = foreign_key_violation. product_has_stock_history()는 stock_ledger만
      // 보므로, 재고 기록은 없지만 주문(order_items, ON DELETE RESTRICT)에 걸린
      // 상품은 위 체크를 통과해 여기서 걸린다 — 어느 테이블이 막았든 사용자에게는
      // 같은 안내(보관 유도)가 맞다.
      if (error.code === "23503") {
        throw new RbacError(
          "이 상품을 참조하는 기록이 있어 삭제할 수 없습니다. 기록을 남겨야 하기 때문입니다 — 대신 '보관'으로 목록에서 감출 수 있습니다."
        );
      }

      throw new Error(error.message);
    }

    // 소유권 확인용 SELECT를 따로 하지 않으므로, 0건 반영(다른 공급사 소유 등)도
    // 여기서 걸러야 한다 — 그렇지 않으면 조용히 아무 것도 지우지 않고 "성공"을 반환한다.
    if (!data) {
      throw new RbacError("삭제 권한이 없거나 해당 상품을 찾을 수 없습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 6. 상품 보관 / 복원
//
// 입출고 기록이 있는 상품은 지울 수 없으므로(위 참고) 목록에서 치우는 수단이
// 따로 필요하다. 보관하면 상품 목록과 고객 카탈로그 양쪽에서 빠지고, 기록은
// 그대로 남는다. 보관 시 판매도 함께 내린다 — 목록에서 감췄는데 미니샵에
// 남아 있으면 사고다.
// ====================================================================
export async function setProductArchivedAction(
  productId: string,
  archived: boolean
): Promise<ActionResult> {
  try {
    const { supabase } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    const { error } = await supabase.rpc("set_product_archived", {
      p_product_id: productId,
      p_archived: archived,
    });

    if (error) {
      if (error.message.includes("PRODUCT_NOT_FOUND")) {
        throw new RbacError("권한이 없거나 해당 상품을 찾을 수 없습니다.");
      }

      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 7. 기본 납품 품목 일괄 등록
// ====================================================================
export async function seedDefaultProductsAction(): Promise<ActionResult<{ created: number }>> {
  try {
    const { supabase, wholesalerId } = await resolveProductScope();

    const { count, error: countError } = await supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("wholesaler_id", wholesalerId);

    if (countError) {
      throw new Error(countError.message);
    }

    if ((count ?? 0) > 0) {
      throw new RbacError(
        "이미 등록된 상품이 있습니다. 기본 납품 품목은 상품이 없을 때만 불러올 수 있습니다."
      );
    }

    const { data, error } = await supabase
      .from("products")
      .insert(
        DEFAULT_DELIVERY_ITEMS.map((item) => ({ wholesaler_id: wholesalerId, ...item }))
      )
      .select("id");

    if (error) {
      throw new Error(error.message);
    }

    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("shop_token")
      .eq("id", wholesalerId)
      .maybeSingle();

    revalidatePath(REVALIDATE_PATH);
    revalidatePath("/dashboard");

    if (wholesaler?.shop_token) {
      revalidatePath(`/shop/${wholesaler.shop_token}`);
    }

    return { success: true, data: { created: data?.length ?? 0 } };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 8. 판매가 일괄 등록
//
// 스캔으로 자동 등록된 상품은 판매가가 0원이라 고객에게 안 보인다. 수십 개를
// 화면에서 하나씩 고치는 건 고통스러워서, 목록을 CSV로 내려받아 엑셀에서 값을
// 채우고 다시 올리는 경로를 둔다. 상품 식별은 UUID로만 한다 — 이름으로 맞추면
// 엑셀에서 이름을 고친 순간 엉뚱한 상품 가격이 바뀐다.
// ====================================================================
export interface BulkPriceResult {
  updated: number;
  /** 값을 안 채운 줄 */
  skipped: number;
  /** ID가 없거나 내 상품이 아니거나 보관된 줄 */
  notFound: number;
}

export async function bulkUpdateProductPricesAction(
  updates: Array<{ id: string; price: number }>,
  activate: boolean
): Promise<ActionResult<BulkPriceResult>> {
  try {
    const { supabase } = await resolveProductScope();

    if (updates.length === 0) {
      throw new RbacError("반영할 판매가가 없습니다.");
    }

    if (updates.length > 5_000) {
      throw new RbacError("한 번에 5,000행까지만 올릴 수 있습니다.");
    }

    const { data, error } = await supabase.rpc("bulk_update_product_prices", {
      p_updates: updates.map((row) => ({ id: row.id, price: String(row.price) })),
      p_activate: activate,
    });

    if (error) {
      throw new Error(error.message);
    }

    const row = (data ?? {}) as Record<string, unknown>;

    revalidatePath(REVALIDATE_PATH);

    return {
      success: true,
      data: {
        updated: Number(row.updated ?? 0),
        skipped: Number(row.skipped ?? 0),
        notFound: Number(row.not_found ?? 0),
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 9. 상품별 재고 구성 조회 (핫딜 지정 판단용)
//
// 상품 등록/수정 화면에서 "이 상품에 오래된 재고가 얼마나 남았는지" 보여줘
// 핫딜을 켤지 판단하게 돕는다. get_product_stock_breakdown RPC(입고 박스
// 단위, 오래된 순)를 그대로 감싼다.
// ====================================================================
export interface ProductStockBreakdownRow {
  boxId: string;
  traceNo: string;
  remainingWeight: number;
  unit: string;
  scannedAt: string;
  bestBefore: string | null;
}

export async function getProductStockBreakdownAction(
  productId: string
): Promise<ActionResult<ProductStockBreakdownRow[]>> {
  try {
    const { supabase } = await resolveProductScope();

    if (!UUID_PATTERN.test(productId)) {
      throw new RbacError("올바른 상품 식별자가 아닙니다.");
    }

    const { data, error } = await supabase.rpc("get_product_stock_breakdown", {
      p_product_id: productId,
    });

    if (error) {
      throw new Error(error.message);
    }

    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      boxId: row.box_id as string,
      traceNo: row.trace_no as string,
      remainingWeight: Number(row.remaining_weight),
      unit: row.unit as string,
      scannedAt: row.scanned_at as string,
      bestBefore: (row.best_before as string | null) ?? null,
    }));

    return { success: true, data: rows };
  } catch (error) {
    return toResult(error);
  }
}
