/**
 * Edge Runtime(미들웨어) 전용 고객 세션 검증.
 * node:crypto는 Edge에서 사용할 수 없으므로 Web Crypto(HMAC-SHA256)로 서명을 검증한다.
 * 서명 발급은 Node 런타임(lib/auth/customer-token.ts)에서만 수행한다.
 */

/** 고객(식당) 미니샵 세션 쿠키 이름 */
export const CUSTOMER_SESSION_COOKIE = "wsale_customer_session";

/** 세션 유효기간 (7일) */
export const CUSTOMER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface CustomerSessionPayload {
  shopToken: string;
  wholesalerId: string;
  organizationId: string | null;
  retailerId: string | null;
  issuedAt: number;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function getSigningSecret(): string | null {
  const secret =
    process.env.CUSTOMER_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!secret || secret.includes("your-supabase")) {
    return null;
  }

  return secret;
}

/** 쿠키 값(`payload.signature`)의 서명·만료를 검증한다. 실패 시 null */
export async function verifyCustomerSessionCookie(
  raw: string | undefined
): Promise<CustomerSessionPayload | null> {
  if (!raw) {
    return null;
  }

  const [payload, signature] = raw.split(".");

  if (!payload || !signature) {
    return null;
  }

  const secret = getSigningSecret();

  if (!secret) {
    return null;
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload)
    );

    if (!isValid) {
      return null;
    }

    const session = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payload))
    ) as CustomerSessionPayload;

    if (!session.shopToken || !session.wholesalerId || !session.issuedAt) {
      return null;
    }

    const ageSeconds = Math.floor(Date.now() / 1000) - session.issuedAt;

    if (ageSeconds > CUSTOMER_SESSION_TTL_SECONDS || ageSeconds < -60) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}
