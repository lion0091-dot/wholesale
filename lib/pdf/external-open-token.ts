import { createHmac, timingSafeEqual } from "crypto";

/**
 * 카카오톡 인앱 브라우저에서 "외부 브라우저에서 열기"를 누르면 Safari 등
 * 완전히 다른 브라우저로 넘어가면서 세션 쿠키가 사라져 로그인 요구가 뜨는
 * 문제를 우회하기 위한 단발성 서명 토큰.
 *
 * DOCUMENT_LINK_SECRET 미설정 시 sign은 null을 반환한다 — 호출부는 토큰 없이
 * 기존처럼 보호된 라우트 링크를 그대로 쓰는 폴백을 유지해야 한다.
 */

export type ExternalOpenDocumentKind = "supplier-statement" | "tax-invoice" | "buyer-statement";

export interface ExternalOpenPayload {
  kind: ExternalOpenDocumentKind;
  orderId: string;
  wholesalerId?: string;
  retailerId?: string;
}

interface SignedPayload extends ExternalOpenPayload {
  exp: number;
}

function getSecret(): string | null {
  return process.env.DOCUMENT_LINK_SECRET || null;
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signExternalOpenToken(
  payload: ExternalOpenPayload,
  ttlSeconds = 600
): string | null {
  const secret = getSecret();

  if (!secret) {
    return null;
  }

  const signed: SignedPayload = { ...payload, exp: Date.now() + ttlSeconds * 1000 };
  const data = Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
  const signature = sign(data, secret);

  return `${data}.${signature}`;
}

export function verifyExternalOpenToken(token: string): ExternalOpenPayload | null {
  const secret = getSecret();

  if (!secret) {
    return null;
  }

  const [data, signature] = token.split(".");

  if (!data || !signature) {
    return null;
  }

  const expectedSignature = sign(data, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  let payload: SignedPayload;

  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    return null;
  }

  const { exp: _exp, ...rest } = payload;

  return rest;
}
