"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface AuthActionResult {
  success: boolean;
  error?: string;
}

/**
 * 로그아웃. 세션 쿠키를 만료시키고 홈으로 이동한다.
 *
 * 로그인은 카카오 OAuth 단일 채널로 통합되어 app/actions/supplier-auth.ts
 * (공급사) 와 app/actions/buyer-auth.ts (바이어) 가 담당한다.
 * 이메일/비밀번호 로그인(signIn)은 폐기했다.
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
