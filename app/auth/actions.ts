"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getLandingPathForRole } from "@/lib/auth/session";
import type { UserRole } from "@/types/database";

export interface AuthActionResult {
  success: boolean;
  error?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 이메일/비밀번호 로그인.
 * 성공 시 profiles.role에 따라 기본 랜딩 경로로 리다이렉트한다.
 */
export async function signIn(formData: FormData): Promise<AuthActionResult> {
  const email = ((formData.get("email") as string) || "").trim().toLowerCase();
  const password = (formData.get("password") as string) || "";

  if (!EMAIL_PATTERN.test(email)) {
    return { success: false, error: "올바른 이메일 주소를 입력해주세요." };
  }

  if (password.length < 8) {
    return { success: false, error: "비밀번호는 8자 이상이어야 합니다." };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    // 계정 존재 여부가 노출되지 않도록 단일 메시지로 통일
    return { success: false, error: "이메일 또는 비밀번호가 올바르지 않습니다." };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  revalidatePath("/", "layout");

  // redirect()는 내부적으로 예외를 던지므로 try/catch 밖에서 호출한다.
  redirect(getLandingPathForRole((profile?.role as UserRole | undefined) ?? null));
}

/**
 * 로그아웃. 세션 쿠키를 만료시키고 홈으로 이동한다.
 */
export async function signOut(): Promise<AuthActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.auth.signOut();

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/", "layout");
  redirect("/");
}
