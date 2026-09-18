"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import { encryptCredential, CredentialCryptoError } from "@/lib/security/credential-crypto";
import type { ActionResult } from "@/app/actions/invite";

/**
 * 공급사별 알림톡 발송대행사(현재는 비즈뿌리오 고정) 연동 설정.
 *
 * 여신 한도 수정(updateCreditLimitAction)과 같은 기준으로 owner/manager만 허용한다 —
 * 실제로 메시지 발송 비용이 발생하는 대행사 계정 자격정보라 일반 staff에게는 안 연다.
 * 비밀번호는 lib/security/credential-crypto.ts로 암호화한 값만 저장하고, 조회 액션은
 * 절대 비밀번호(평문이든 암호문이든)를 클라이언트로 내려보내지 않는다 — 설정 여부만 알려준다.
 */

export interface AlimtalkTemplateCodes {
  orderNew?: string;
  cancelRequest?: string;
  creditExceeded?: string;
  receivablesReminder?: string;
  creditLimitChanged?: string;
}

export interface AlimtalkSettingsStatus {
  /** 비밀번호가 저장돼 있는지 여부 — 값 자체는 절대 내려주지 않는다 */
  configured: boolean;
  account: string | null;
  senderKey: string | null;
  senderPhone: string | null;
  templateCodes: AlimtalkTemplateCodes;
}

export interface SaveAlimtalkSettingsInput {
  account: string;
  /** 빈 문자열이면 기존에 저장된 비밀번호를 그대로 유지한다(재입력 강제 안 함). */
  password: string;
  senderKey: string;
  senderPhone: string;
  templateCodes: AlimtalkTemplateCodes;
}

function toTemplateCodes(value: unknown): AlimtalkTemplateCodes {
  if (!value || typeof value !== "object") {
    return {};
  }

  const raw = value as Record<string, unknown>;

  return {
    orderNew: typeof raw.orderNew === "string" ? raw.orderNew : undefined,
    cancelRequest: typeof raw.cancelRequest === "string" ? raw.cancelRequest : undefined,
    creditExceeded: typeof raw.creditExceeded === "string" ? raw.creditExceeded : undefined,
    receivablesReminder:
      typeof raw.receivablesReminder === "string" ? raw.receivablesReminder : undefined,
    creditLimitChanged:
      typeof raw.creditLimitChanged === "string" ? raw.creditLimitChanged : undefined,
  };
}

export async function getAlimtalkSettingsAction(): Promise<ActionResult<AlimtalkSettingsStatus>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("wholesalers")
      .select("alimtalk_account, alimtalk_password_encrypted, alimtalk_sender_key, alimtalk_sender_phone, alimtalk_template_codes")
      .eq("id", scope.wholesalerId)
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    if (!data) {
      return { success: false, error: "업체 정보를 찾을 수 없습니다." };
    }

    return {
      success: true,
      data: {
        configured: Boolean(data.alimtalk_password_encrypted),
        account: (data.alimtalk_account as string | null) ?? null,
        senderKey: (data.alimtalk_sender_key as string | null) ?? null,
        senderPhone: (data.alimtalk_sender_phone as string | null) ?? null,
        templateCodes: toTemplateCodes(data.alimtalk_template_codes),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "설정 조회 중 오류가 발생했습니다.",
    };
  }
}

export async function saveAlimtalkSettingsAction(
  input: SaveAlimtalkSettingsInput
): Promise<ActionResult> {
  try {
    await requireOrgRole(["owner", "manager"]);

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const account = input.account.trim();

    if (!account) {
      return { success: false, error: "비즈뿌리오 계정을 입력해주세요." };
    }

    const updates: Record<string, unknown> = {
      alimtalk_provider: "bizppurio",
      alimtalk_account: account,
      alimtalk_sender_key: input.senderKey.trim() || null,
      alimtalk_sender_phone: input.senderPhone.trim() || null,
      alimtalk_template_codes: input.templateCodes,
    };

    if (input.password) {
      try {
        updates.alimtalk_password_encrypted = encryptCredential(input.password);
      } catch (error) {
        if (error instanceof CredentialCryptoError) {
          return { success: false, error: error.message };
        }
        throw error;
      }
    }

    const supabase = await createClient();
    const { error } = await supabase
      .from("wholesalers")
      .update(updates)
      .eq("id", scope.wholesalerId);

    if (error) {
      return { success: false, error: error.message };
    }

    revalidatePath("/dashboard/invites");

    return { success: true };
  } catch (error) {
    if (error instanceof RbacError) {
      return { success: false, error: error.message };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "저장 중 오류가 발생했습니다.",
    };
  }
}
