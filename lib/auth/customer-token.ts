import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_TTL_SECONDS as SESSION_TTL_SECONDS,
} from "@/lib/auth/customer-token-edge";

export { CUSTOMER_SESSION_COOKIE };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShopTokenTarget {
  shopToken: string;
  wholesalerId: string;
  organizationId: string | null;
  businessName: string;
}

export interface CustomerSession {
  /** 초대 링크의 shop_token */
  shopToken: string;
  /** 공급사(도매) 식별자 */
  wholesalerId: string;
  /** 공급사 조직 식별자 (조직 미생성 시 null) */
  organizationId: string | null;
  /** 로그인 후 바인딩된 식당 식별자 (미로그인 열람 시 null) */
  retailerId: string | null;
  /** 발급 시각 (epoch seconds) */
  issuedAt: number;
}

export class CustomerTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerTokenError";
  }
}

/** 쿠키 서명 키. 운영 환경에서는 CUSTOMER_SESSION_SECRET을 반드시 설정한다. */
function getSigningSecret(): string {
  const secret =
    process.env.CUSTOMER_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!secret || secret.includes("your-supabase")) {
    throw new CustomerTokenError(
      "CUSTOMER_SESSION_SECRET이 설정되지 않아 고객 세션을 발급할 수 없습니다."
    );
  }

  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSigningSecret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/** 세션 페이로드를 `payload.signature` 형태로 직렬화 + HMAC 서명 */
export function serializeCustomerSession(session: CustomerSession): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

/** 쿠키 값 검증 및 역직렬화. 위조/만료 시 null */
export function deserializeCustomerSession(raw: string | undefined): CustomerSession | null {
  if (!raw) {
    return null;
  }

  const [payload, signature] = raw.split(".");

  if (!payload || !signature) {
    return null;
  }

  let expected: string;

  try {
    expected = sign(payload);
  } catch {
    return null;
  }

  if (!safeEqual(signature, expected)) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CustomerSession;

    if (!session.shopToken || !session.wholesalerId || !session.issuedAt) {
      return null;
    }

    const ageSeconds = Math.floor(Date.now() / 1000) - session.issuedAt;

    if (ageSeconds > SESSION_TTL_SECONDS || ageSeconds < -60) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * 초대 토큰(shop_token) 검증.
 * 활성(active) 상태의 공급사만 통과시키고, 연결된 조직 ID까지 함께 반환한다.
 */
export async function validateShopToken(shopToken: string): Promise<ShopTokenTarget | null> {
  if (!UUID_PATTERN.test(shopToken)) {
    return null;
  }

  const supabase = await createClient();

  const { data: wholesaler } = await supabase
    .from("wholesalers")
    .select("id, business_name, shop_token, status")
    .eq("shop_token", shopToken)
    .maybeSingle();

  if (!wholesaler || wholesaler.status !== "active") {
    return null;
  }

  const { data: organization } = await supabase
    .from("organizations")
    .select("id")
    .eq("wholesaler_id", wholesaler.id)
    .maybeSingle();

  return {
    shopToken,
    wholesalerId: wholesaler.id as string,
    organizationId: (organization?.id as string | undefined) ?? null,
    businessName: wholesaler.business_name as string,
  };
}

/** 세션 쿠키 저장 (httpOnly / SameSite=Lax — 카카오 인앱 브라우저 호환) */
export async function setCustomerSessionCookie(session: CustomerSession): Promise<void> {
  const cookieStore = await cookies();

  cookieStore.set(CUSTOMER_SESSION_COOKIE, serializeCustomerSession(session), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** 현재 요청의 고객 세션 조회 (없거나 위조면 null) */
export async function getCustomerSession(): Promise<CustomerSession | null> {
  const cookieStore = await cookies();

  return deserializeCustomerSession(cookieStore.get(CUSTOMER_SESSION_COOKIE)?.value);
}

/** 고객 세션 필수 */
export async function requireCustomerSession(): Promise<CustomerSession> {
  const session = await getCustomerSession();

  if (!session) {
    throw new CustomerTokenError("미니샵 세션이 만료되었습니다. 초대 링크로 다시 접속해주세요.");
  }

  return session;
}

/** 세션이 지정한 미니샵 토큰과 동일한지 검증 (타 공급사 교차 접근 차단) */
export async function requireCustomerSessionForToken(
  shopToken: string
): Promise<CustomerSession> {
  const session = await requireCustomerSession();

  if (session.shopToken !== shopToken) {
    throw new CustomerTokenError("다른 공급사의 미니샵 세션입니다. 초대 링크로 다시 접속해주세요.");
  }

  return session;
}

/** 세션 쿠키 삭제 */
export async function clearCustomerSessionCookie(): Promise<void> {
  const cookieStore = await cookies();

  cookieStore.delete(CUSTOMER_SESSION_COOKIE);
}
