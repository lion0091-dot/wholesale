"use server";

import { revalidatePath } from "next/cache";
import { readWholesalerCredentials, updateWholesalerCredentials } from "@/lib/security/wholesaler-credentials";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import { encryptCredential, CredentialCryptoError } from "@/lib/security/credential-crypto";
import type { ActionResult } from "@/app/actions/invite";

/**
 * 공급사별 PG(현재는 토스페이먼츠 고정) 연동 설정.
 *
 * 알림톡과 동일한 이유로 owner/manager만 허용한다(`updateCreditLimitAction`과 같은
 * 기준) — 실제 결제/환불이 걸린 자격정보라 일반 staff에게는 안 연다. 시크릿키는
 * lib/security/credential-crypto.ts로 암호화한 값만 저장하고, 조회 액션은 절대
 * 시크릿키(평문이든 암호문이든)를 클라이언트로 내려보내지 않는다 — 설정 여부만 알려준다.
 * 클라이언트키는 프론트 위젯에 그대로 노출되는 값이라 암호화하지 않는다.
 */

export interface PgSettingsStatus {
  /** 시크릿키가 저장돼 있는지 여부 — 값 자체는 절대 내려주지 않는다 */
  configured: boolean;
  clientKey: string | null;
}

export interface SavePgSettingsInput {
  clientKey: string;
  /** 빈 문자열이면 기존에 저장된 시크릿키를 그대로 유지한다(재입력 강제 안 함). */
  secretKey: string;
}

export async function getPgSettingsAction(): Promise<ActionResult<PgSettingsStatus>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const { data, error } = await readWholesalerCredentials(
      scope.wholesalerId,
      "pg_client_key, pg_secret_key_encrypted"
    );

    if (error) {
      return { success: false, error };
    }

    if (!data) {
      return { success: false, error: "업체 정보를 찾을 수 없습니다." };
    }

    return {
      success: true,
      data: {
        configured: Boolean(data.pg_secret_key_encrypted),
        clientKey: (data.pg_client_key as string | null) ?? null,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "설정 조회 중 오류가 발생했습니다.",
    };
  }
}

export async function savePgSettingsAction(input: SavePgSettingsInput): Promise<ActionResult> {
  try {
    await requireOrgRole(["owner", "manager"]);

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const clientKey = input.clientKey.trim();

    if (!clientKey) {
      return { success: false, error: "토스페이먼츠 클라이언트 키를 입력해주세요." };
    }

    const updates: Record<string, unknown> = {
      pg_provider: "tosspayments",
      pg_client_key: clientKey,
    };

    if (input.secretKey) {
      try {
        updates.pg_secret_key_encrypted = encryptCredential(input.secretKey);
      } catch (error) {
        if (error instanceof CredentialCryptoError) {
          return { success: false, error: error.message };
        }
        throw error;
      }
    }

    // 위에서 owner/manager와 소속 공급사를 확인했다. wholesalers UPDATE 정책은 사장 본인만 통과시켜
    // 매니저 저장이 조용히 0행이 되므로 service_role로 쓴다.
    const { error } = await updateWholesalerCredentials(scope.wholesalerId, updates);

    if (error) {
      return { success: false, error };
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
