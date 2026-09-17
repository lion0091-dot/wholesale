"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSuperAdmin, RbacError } from "@/lib/auth/rbac";

export interface ActionResult {
  success: boolean;
  error?: string;
}

export async function addProductCategoryAction(name: string): Promise<ActionResult> {
  try {
    await requireSuperAdmin();

    const trimmed = name.trim();

    if (trimmed.length < 1 || trimmed.length > 20) {
      return { success: false, error: "카테고리명은 1~20자여야 합니다." };
    }

    const supabase = await createClient();
    const { data: maxRow } = await supabase
      .from("product_categories")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextOrder = ((maxRow?.sort_order as number | undefined) ?? 0) + 1;

    const { error } = await supabase
      .from("product_categories")
      .insert({ name: trimmed, sort_order: nextOrder });

    if (error) {
      if (error.code === "23505") {
        return { success: false, error: "이미 있는 카테고리입니다." };
      }
      return { success: false, error: "추가에 실패했습니다." };
    }

    revalidatePath("/admin/categories");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof RbacError ? err.message : "오류가 발생했습니다." };
  }
}

export async function deleteProductCategoryAction(id: string): Promise<ActionResult> {
  try {
    await requireSuperAdmin();

    const supabase = await createClient();
    const { error } = await supabase.from("product_categories").delete().eq("id", id);

    if (error) {
      return { success: false, error: "삭제에 실패했습니다." };
    }

    revalidatePath("/admin/categories");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof RbacError ? err.message : "오류가 발생했습니다." };
  }
}

export async function addProductSubcategoryAction(
  categoryId: string,
  name: string
): Promise<ActionResult> {
  try {
    await requireSuperAdmin();

    const trimmed = name.trim();

    if (trimmed.length < 1 || trimmed.length > 20) {
      return { success: false, error: "부위명은 1~20자여야 합니다." };
    }

    const supabase = await createClient();
    const { data: maxRow } = await supabase
      .from("product_subcategories")
      .select("sort_order")
      .eq("category_id", categoryId)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextOrder = ((maxRow?.sort_order as number | undefined) ?? 0) + 1;

    const { error } = await supabase
      .from("product_subcategories")
      .insert({ category_id: categoryId, name: trimmed, sort_order: nextOrder });

    if (error) {
      if (error.code === "23505") {
        return { success: false, error: "이미 있는 부위입니다." };
      }
      return { success: false, error: "추가에 실패했습니다." };
    }

    revalidatePath("/admin/categories");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof RbacError ? err.message : "오류가 발생했습니다." };
  }
}

export async function deleteProductSubcategoryAction(id: string): Promise<ActionResult> {
  try {
    await requireSuperAdmin();

    const supabase = await createClient();
    const { error } = await supabase.from("product_subcategories").delete().eq("id", id);

    if (error) {
      return { success: false, error: "삭제에 실패했습니다." };
    }

    revalidatePath("/admin/categories");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof RbacError ? err.message : "오류가 발생했습니다." };
  }
}
