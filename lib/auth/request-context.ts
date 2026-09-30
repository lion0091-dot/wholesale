import type { OrgRole } from "@/lib/auth/rbac";
import type { SubscriptionStatus, UserRole } from "@/types/database";

/**
 * 미들웨어(/dashboard 가드)가 이미 검증한 신원·조직 정보를 같은 요청의 Server Component /
 * Server Action으로 넘기는 서명 토큰. getOrgStaffContext()가 이걸로 DB 재조회를 건너뛴다.
 *
 * 헤더가 "있다"는 사실만으로는 절대 신뢰하지 않는다. 미들웨어 matcher가 제외하는 경로
 * (예: 동적 라우트 /shop/x.png)나 미들웨어가 헤더를 새로 쓰지 않는 경로에서는 클라이언트가
 * 보낸 헤더가 그대로 도착할 수 있다. 그래서 아래 세 가지가 전부 맞아야만 통과한다.
 *  - HMAC 서명(서버 전용 비밀키) — 클라이언트는 유효한 토큰을 만들 수 없다.
 *  - 세션 쿠키 지문을 서명에 포함 — 토큰이 새더라도 그 사용자의 세션 쿠키 없이는 재사용 불가.
 *  - 짧은 만료(60초) — 같은 요청 안에서만 쓰는 값이다.
 * 하나라도 어긋나거나 비밀키가 없으면 null → 호출부는 기존 DB 조회로 폴백한다(fail-closed).
 *
 * Edge(미들웨어)와 Node 양쪽에서 돌아야 하므로 Web Crypto만 쓴다.
 */

export const STAFF_CONTEXT_HEADER = "x-wsale-staff-context";

const SIGNING_LABEL = "wsale:staff-context:v1";
const TOKEN_TTL_MS = 60_000;
const ORG_ROLES: ReadonlySet<string> = new Set(["owner", "manager", "staff"]);

export interface TrustedOrganization {
  name: string | null;
  wholesalerId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
}

export interface TrustedStaffContext {
  userId: string;
  email: string | null;
  platformRole: UserRole | null;
  organizationId: string | null;
  orgRole: OrgRole | null;
  /** 레이아웃 표시용 (권한 판정에 쓰지 않는다) */
  displayName: string;
  organization: TrustedOrganization | null;
}

interface TokenPayload {
  exp: number;
  ctx: TrustedStaffContext;
}

interface CookieLike {
  name: string;
  value: string;
}

/**
 * 서명 키 재료. 별도 env를 늘리지 않으려고 서버 전용인 service_role 키를 쓰고,
 * 서명 메시지 앞에 SIGNING_LABEL을 붙여 다른 용도의 서명과 섞이지 않게 한다.
 * 없거나 자리표시자(.env.example 값 등 공개된 문자열)면 서명 자체를 끈다.
 */
function getSigningSecret(): string | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret || secret.length < 32 || secret.includes("your-") || secret.includes("placeholder")) {
    return null;
  }

  return secret;
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function getHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    cachedKey = {
      secret,
      key: crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
      ),
    };
  }

  return cachedKey.key;
}

/**
 * Supabase 세션 쿠키(sb-<ref>-auth-token, 분할 시 .0/.1 …)만 이름순으로 모은다.
 * 빈 값은 토큰 갱신 때 지워지는 청크라 미들웨어/렌더 양쪽에서 제외해야 지문이 일치한다.
 */
export function sessionCookieFingerprint(cookies: CookieLike[]): string {
  return cookies
    .filter((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("-auth-token") && cookie.value !== "")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("\n");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    return null;
  }

  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  } catch {
    return null;
  }
}

function signingMessage(payloadB64: string, fingerprint: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${SIGNING_LABEL}\n${payloadB64}\n${fingerprint}`);
}

/** 미들웨어 전용. 비밀키나 세션 쿠키가 없으면 null(헤더를 싣지 않는다). */
export async function signStaffContext(
  ctx: TrustedStaffContext,
  cookies: CookieLike[],
  now: number
): Promise<string | null> {
  const secret = getSigningSecret();
  const fingerprint = sessionCookieFingerprint(cookies);

  if (!secret || !fingerprint) {
    return null;
  }

  const payload: TokenPayload = { exp: now + TOKEN_TTL_MS, ctx };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await getHmacKey(secret),
    signingMessage(payloadB64, fingerprint)
  );

  return `${payloadB64}.${toBase64Url(new Uint8Array(signature))}`;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseContext(value: unknown): TrustedStaffContext | null {
  if (!value || typeof value !== "object") return null;

  const ctx = value as Record<string, unknown>;

  if (typeof ctx.userId !== "string" || !ctx.userId) return null;
  if (!isNullableString(ctx.email) || !isNullableString(ctx.platformRole)) return null;
  if (!isNullableString(ctx.organizationId) || !isNullableString(ctx.orgRole)) return null;
  if (ctx.orgRole !== null && !ORG_ROLES.has(ctx.orgRole)) return null;
  if ((ctx.organizationId === null) !== (ctx.orgRole === null)) return null;
  if (typeof ctx.displayName !== "string") return null;

  let organization: TrustedOrganization | null = null;

  if (ctx.organization !== null) {
    if (!ctx.organization || typeof ctx.organization !== "object") return null;

    const org = ctx.organization as Record<string, unknown>;

    if (!isNullableString(org.name) || !isNullableString(org.wholesalerId) || !isNullableString(org.subscriptionStatus)) {
      return null;
    }

    organization = {
      name: org.name,
      wholesalerId: org.wholesalerId,
      subscriptionStatus: org.subscriptionStatus as SubscriptionStatus | null,
    };
  }

  return {
    userId: ctx.userId,
    email: ctx.email,
    platformRole: ctx.platformRole as UserRole | null,
    organizationId: ctx.organizationId,
    orgRole: ctx.orgRole as OrgRole | null,
    displayName: ctx.displayName,
    organization,
  };
}

/** 서명·세션 지문·만료·형태가 전부 맞을 때만 컨텍스트를 돌려준다. 그 외엔 모두 null. */
export async function verifyStaffContext(
  token: string | null | undefined,
  cookies: CookieLike[],
  now: number
): Promise<TrustedStaffContext | null> {
  const secret = getSigningSecret();
  const fingerprint = sessionCookieFingerprint(cookies);

  if (!secret || !fingerprint || !token) {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [payloadB64, signatureB64] = parts;
  const signature = fromBase64Url(signatureB64);
  const payloadBytes = fromBase64Url(payloadB64);

  if (!signature || !payloadBytes || !payloadB64) {
    return null;
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    await getHmacKey(secret),
    signature,
    signingMessage(payloadB64, fingerprint)
  );

  if (!valid) {
    return null;
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<TokenPayload>;

    if (typeof payload.exp !== "number" || now > payload.exp) {
      return null;
    }

    return parseContext(payload.ctx);
  } catch {
    return null;
  }
}
