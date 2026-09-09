"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function createProduct(formData: FormData) {
  const supabase = await createClient();

  const name = formData.get("name") as string;
  const category = formData.get("category") as string;
  const origin = formData.get("origin") as string;
  const grade = (formData.get("grade") as string) || null;
  const base_price = parseFloat(formData.get("base_price") as string);
  const unit = (formData.get("unit") as string) || "kg";
  const stock_quantity = parseFloat((formData.get("stock_quantity") as string) || "0");
  const is_secret_deal = formData.get("is_secret_deal") === "on";
  const description = (formData.get("description") as string) || null;

  // Supabase Auth 세션에서 도매업자 정보 조회
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { success: false, error: "인증되지 않은 사용자입니다. 로그인 후 다시 시도해주세요." };
  }

  const { data: wholesaler, error: wholesalerError } = await supabase
    .from("wholesalers")
    .select("id")
    .eq("profile_id", user.id)
    .single();

  if (wholesalerError || !wholesaler) {
    return { success: false, error: "도매업자 등록 정보를 찾을 수 없습니다." };
  }

  const { error } = await supabase.from("products").insert({
    wholesaler_id: wholesaler.id,
    name,
    category,
    origin,
    grade,
    base_price,
    unit,
    stock_quantity,
    is_secret_deal,
    is_active: true,
    description,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/wholesaler/products");
  return { success: true };
}

export async function toggleProductActive(productId: string, currentStatus: boolean) {
  const supabase = await createClient();

  const { error } = await supabase
    .from("products")
    .update({ is_active: !currentStatus })
    .eq("id", productId);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/wholesaler/products");
  return { success: true };
}

export async function toggleSecretDeal(productId: string, currentStatus: boolean) {
  const supabase = await createClient();

  const { error } = await supabase
    .from("products")
    .update({ is_secret_deal: !currentStatus })
    .eq("id", productId);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/wholesaler/products");
  return { success: true };
}

export async function updateProductStock(productId: string, newStock: number) {
  const supabase = await createClient();

  if (newStock < 0) {
    return { success: false, error: "재고 수량은 0 이상이어야 합니다." };
  }

  const { error } = await supabase
    .from("products")
    .update({ stock_quantity: newStock })
    .eq("id", productId);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/wholesaler/products");
  return { success: true };
}

export async function deleteProduct(productId: string) {
  const supabase = await createClient();

  const { error } = await supabase
    .from("products")
    .delete()
    .eq("id", productId);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/wholesaler/products");
  return { success: true };
}
