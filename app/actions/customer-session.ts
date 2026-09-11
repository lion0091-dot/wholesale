"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  CustomerTokenError,
  clearCustomerSessionCookie,
  getCustomerSession,
  requireCustomerSession,
  setCustomerSessionCookie,
  validateShopToken,
  type CustomerSession,
} from "@/lib/auth/customer-token";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface CustomerSessionInfo {
  shopToken: string;
  wholesalerId: string;
  organizationId: string | null;
  retailerId: string | null;
  businessName?: string;
  /** 로그인 + 거래 관계까지 확인된 단골 고객 여부 */
  isLinkedCustomer: boolean;
}

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof CustomerTokenError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/**
 * 로그인 사용자의 식당(retailer) ID와, 해당 공급사와의 활성 거래 관계 여부를 조회한다.
 * 미로그인/식당 미등록이면 null.
 */
async function resolveRetailerBinding(
  wholesalerId: string
): Promise<{ retailerId: string; isLinked: boolean } | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  // RBAC: 도매 계정은 고객 세션을 가질 수 없다 (경쟁사 염탐 차단)
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role === "wholesaler") {
    throw new CustomerTokenError("도매(공급사) 계정으로는 미니샵 고객 세션을 사용할 수 없습니다.");
  }

  const { data: retailer } = await supabase
    .from("retailers")
    .select("id")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (!retailer) {
    return null;
  }

  const { data: relation } = await supabase
    .from("wholesaler_retailers")
    .select("id, status")
    .eq("wholesaler_id", wholesalerId)
    .eq("retailer_id", retailer.id)
    .maybeSingle();

  return {
    retailerId: retailer.id as string,
    isLinked: relation?.status === "active",
  };
}

// ====================================================================
// 1. 초대 토큰 진입 처리 (카카오 링크 클릭 → 세션 쿠키 발급)
// ====================================================================
export async function enterShopWithToken(
  shopToken: string
): Promise<ActionResult<CustomerSessionInfo>> {
  try {
    const target = await validateShopToken(shopToken);

    if (!target) {
      throw new CustomerTokenError("유효하지 않거나 만료된 초대 링크입니다.");
    }

    const binding = await resolveRetailerBinding(target.wholesalerId);

    const session: CustomerSession = {
      shopToken: target.shopToken,
      wholesalerId: target.wholesalerId,
      organizationId: target.organizationId,
      retailerId: binding?.retailerId ?? null,
      issuedAt: Math.floor(Date.now() / 1000),
    };

    await setCustomerSessionCookie(session);
    revalidatePath(`/shop/${target.shopToken}`);

    return {
      success: true,
      data: {
        shopToken: session.shopToken,
        wholesalerId: session.wholesalerId,
        organizationId: session.organizationId,
        retailerId: session.retailerId,
        businessName: target.businessName,
        isLinkedCustomer: binding?.isLinked ?? false,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 2. 로그인 후 고객 세션 바인딩 (retailer_id 주입)
// ====================================================================
export async function bindCustomerSession(): Promise<ActionResult<CustomerSessionInfo>> {
  try {
    const session = await requireCustomerSession();

    // 세션의 토큰을 재검증하여 정지/해지된 공급사 접근을 차단
    const target = await validateShopToken(session.shopToken);

    if (!target || target.wholesalerId !== session.wholesalerId) {
      await clearCustomerSessionCookie();
      throw new CustomerTokenError("미니샵 접근 권한이 변경되었습니다. 초대 링크로 다시 접속해주세요.");
    }

    const binding = await resolveRetailerBinding(session.wholesalerId);

    if (!binding) {
      throw new CustomerTokenError("식당(바이어) 정보가 등록되지 않았습니다. 회원 정보를 먼저 등록해주세요.");
    }

    const updated: CustomerSession = {
      ...session,
      organizationId: target.organizationId,
      retailerId: binding.retailerId,
      issuedAt: Math.floor(Date.now() / 1000),
    };

    await setCustomerSessionCookie(updated);
    revalidatePath(`/shop/${session.shopToken}`);

    return {
      success: true,
      data: {
        shopToken: updated.shopToken,
        wholesalerId: updated.wholesalerId,
        organizationId: updated.organizationId,
        retailerId: updated.retailerId,
        businessName: target.businessName,
        isLinkedCustomer: binding.isLinked,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 3. 현재 고객 세션 조회
// ====================================================================
export async function getCustomerSessionInfo(): Promise<ActionResult<CustomerSessionInfo | null>> {
  try {
    const session = await getCustomerSession();

    if (!session) {
      return { success: true, data: null };
    }

    return {
      success: true,
      data: {
        shopToken: session.shopToken,
        wholesalerId: session.wholesalerId,
        organizationId: session.organizationId,
        retailerId: session.retailerId,
        isLinkedCustomer: session.retailerId !== null,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 4. 미니샵 이탈 (세션 쿠키 삭제)
// ====================================================================
export async function leaveShop(): Promise<ActionResult> {
  try {
    const session = await getCustomerSession();

    await clearCustomerSessionCookie();

    if (session) {
      revalidatePath(`/shop/${session.shopToken}`);
    }

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}
