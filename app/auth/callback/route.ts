/**
 * OAuth 콜백 — 카카오 로그인 코드를 Supabase Auth 세션으로 교환한다.
 *
 * 공급사와 바이어가 같은 카카오 채널을 쓰므로 이 라우트가 두 흐름을 함께 처리한다.
 * 구분 기준은 쿼리스트링 하나뿐이다.
 *
 *   ?shop_token=<uuid>    바이어 — claim_shop_access() 로
 *                         auth.uid() ↔ profiles ↔ retailers ↔ wholesaler_retailers 매핑 확정
 *   ?intent=supplier      공급사 — 최소 정보(약관/연락처/상호) 미입력이면 /onboarding,
 *                         완료 상태면 백오피스로 복귀
 *
 * 어느 경로든 이 시점 이후 모든 권한 판정은 auth.uid() 만 사용한다.
 * (공급사 profiles 기본 레코드는 auth.users INSERT 트리거가 이미 만들어 두었다)
 */

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  claimShopAccess,
  isValidShopToken,
  sanitizeShopReturnPath,
} from "@/lib/auth/buyer-auth";
import {
  SUPPLIER_INTENT,
  SUPPLIER_LANDING_PATH,
  SUPPLIER_ONBOARDING_PATH,
  sanitizeSupplierReturnPath,
} from "@/lib/auth/supplier-auth";
import { getSupplierAccount } from "@/lib/supplier/verification";

/** 진입 화면에 표시할 실패 사유 (쿼리스트링으로 전달) */
type CallbackError = "denied" | "exchange_failed" | "claim_failed";

function redirectWithError(
  request: NextRequest,
  path: string,
  error: CallbackError,
  message?: string
) {
  const url = new URL(path, request.url);

  url.searchParams.set("auth_error", error);

  if (message) {
    url.searchParams.set("auth_message", message);
  }

  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const shopToken = searchParams.get("shop_token");
  const isSupplierFlow = searchParams.get("intent") === SUPPLIER_INTENT;

  // 오픈 리다이렉트 방지: 바이어는 /shop/<uuid> 하위, 공급사는 내부 절대 경로만 허용한다.
  const nextPath = isSupplierFlow
    ? (sanitizeSupplierReturnPath(searchParams.get("next")) ?? SUPPLIER_LANDING_PATH)
    : (sanitizeShopReturnPath(searchParams.get("next")) ??
      (isValidShopToken(shopToken) ? `/shop/${shopToken}` : "/"));

  // 실패 시 되돌아갈 화면 (공급사는 로그인 게이트, 바이어는 미니샵 게이트)
  const errorPath = isSupplierFlow ? "/login" : nextPath;

  // 사용자가 카카오 동의 화면에서 취소한 경우
  if (searchParams.get("error") || !code) {
    return redirectWithError(
      request,
      errorPath,
      "denied",
      "카카오 로그인이 취소되었습니다. 다시 시도해주세요."
    );
  }

  const supabase = await createClient();

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return redirectWithError(
      request,
      errorPath,
      "exchange_failed",
      "카카오 로그인 처리에 실패했습니다. 잠시 후 다시 시도해주세요."
    );
  }

  // ------------------------------------------------------------------
  // 공급사 — 최소 정보 입력 여부로 도착지를 나눈다.
  //   가입 직후(트리거가 만든 기본 레코드 상태)에는 약관 동의/상호가 비어 있다.
  // ------------------------------------------------------------------
  if (isSupplierFlow) {
    const account = await getSupplierAccount();

    if (!account) {
      return redirectWithError(
        request,
        errorPath,
        "exchange_failed",
        "로그인 세션을 확인할 수 없습니다. 다시 시도해주세요."
      );
    }

    // 바이어로 확정된 계정은 공급사 백오피스로 들어갈 수 없다.
    if (account.platformRole === "retailer") {
      return redirectWithError(
        request,
        errorPath,
        "claim_failed",
        "이미 바이어(구매 회원)로 가입된 카카오 계정입니다. 공급사 가입은 다른 카카오 계정으로 진행해주세요."
      );
    }

    return NextResponse.redirect(
      new URL(account.needsMinimumInfo ? SUPPLIER_ONBOARDING_PATH : nextPath, request.url)
    );
  }

  // ------------------------------------------------------------------
  // 바이어 — 초대 링크(shop_token) 소지 = 초대의 증거. 거래처 매핑을 확정한다.
  // ------------------------------------------------------------------
  if (isValidShopToken(shopToken)) {
    try {
      const result = await claimShopAccess(shopToken as string);

      if (!result.isLinked) {
        return redirectWithError(
          request,
          nextPath,
          "claim_failed",
          "공급사가 거래를 차단한 상태입니다. 공급사에 직접 문의해주세요."
        );
      }
    } catch (error) {
      return redirectWithError(
        request,
        nextPath,
        "claim_failed",
        error instanceof Error ? error.message : "단골 등록에 실패했습니다."
      );
    }
  }

  return NextResponse.redirect(new URL(nextPath, request.url));
}
