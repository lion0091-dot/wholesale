import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  signStaffContext,
  verifyStaffContext,
  type TrustedStaffContext,
} from "./request-context";

const SECRET = "test-service-role-secret-0123456789abcdef";
const NOW = 1_800_000_000_000;

const ctx: TrustedStaffContext = {
  userId: "user-a",
  email: null,
  platformRole: "wholesaler",
  organizationId: "org-a",
  orgRole: "staff",
  displayName: "홍길동",
  organization: { name: "태양축산", wholesalerId: "w-a", subscriptionStatus: "active" },
};

const sessionA = [
  { name: "sb-ref-auth-token.0", value: "chunk-a0" },
  { name: "sb-ref-auth-token.1", value: "chunk-a1" },
  { name: "other", value: "x" },
];
const sessionB = [{ name: "sb-ref-auth-token", value: "token-b" }];

function toB64Url(text: string) {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("staff context token", () => {
  const original = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = original;
  });

  it("같은 세션·만료 전이면 그대로 복원된다", async () => {
    const token = await signStaffContext(ctx, sessionA, NOW);

    expect(await verifyStaffContext(token, sessionA, NOW + 1000)).toEqual(ctx);
  });

  it("비세션 쿠키 변화나 빈 청크, 쿠키 순서는 지문에 영향이 없다", async () => {
    const token = await signStaffContext(ctx, sessionA, NOW);
    const reordered = [
      { name: "sb-ref-auth-token.2", value: "" },
      sessionA[1],
      sessionA[0],
      { name: "other", value: "changed" },
    ];

    expect(await verifyStaffContext(token, reordered, NOW)).toEqual(ctx);
  });

  it("헤더가 없거나 형식이 깨졌으면 null", async () => {
    expect(await verifyStaffContext(null, sessionA, NOW)).toBeNull();
    expect(await verifyStaffContext("", sessionA, NOW)).toBeNull();
    expect(await verifyStaffContext("org-a", sessionA, NOW)).toBeNull();
    expect(await verifyStaffContext("a.b.c", sessionA, NOW)).toBeNull();
    expect(await verifyStaffContext("!!!.???", sessionA, NOW)).toBeNull();
  });

  it("클라이언트가 서명 없이 만든 페이로드는 거부된다", async () => {
    const forged = toB64Url(JSON.stringify({ exp: NOW + 60_000, ctx: { ...ctx, orgRole: "owner" } }));

    expect(await verifyStaffContext(`${forged}.`, sessionA, NOW)).toBeNull();
    expect(await verifyStaffContext(`${forged}.AAAA`, sessionA, NOW)).toBeNull();
  });

  it("서명된 토큰의 페이로드를 바꾸면(권한 상승·타 조직) 거부된다", async () => {
    const token = (await signStaffContext(ctx, sessionA, NOW))!;
    const [, signature] = token.split(".");
    const tampered = toB64Url(
      JSON.stringify({ exp: NOW + 60_000, ctx: { ...ctx, organizationId: "org-victim", orgRole: "owner" } })
    );

    expect(await verifyStaffContext(`${tampered}.${signature}`, sessionA, NOW)).toBeNull();
  });

  it("다른 사용자의 세션 쿠키로는 재사용할 수 없다", async () => {
    const token = await signStaffContext(ctx, sessionA, NOW);

    expect(await verifyStaffContext(token, sessionB, NOW)).toBeNull();
    expect(await verifyStaffContext(token, [], NOW)).toBeNull();
  });

  it("만료되면 거부된다", async () => {
    const token = await signStaffContext(ctx, sessionA, NOW);

    expect(await verifyStaffContext(token, sessionA, NOW + 60_001)).toBeNull();
  });

  it("다른 비밀키로 서명된 토큰은 거부된다", async () => {
    const token = await signStaffContext(ctx, sessionA, NOW);

    process.env.SUPABASE_SERVICE_ROLE_KEY = `${SECRET}-rotated`;
    expect(await verifyStaffContext(token, sessionA, NOW)).toBeNull();
  });

  it("비밀키가 없거나 자리표시자면 서명도 검증도 하지 않는다", async () => {
    const token = await signStaffContext(ctx, sessionA, NOW);

    for (const value of [undefined, "", "your-supabase-service-role-key-xxxxxxxxxxxxxxxx", "short"]) {
      if (value === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = value;

      expect(await signStaffContext(ctx, sessionA, NOW)).toBeNull();
      expect(await verifyStaffContext(token, sessionA, NOW)).toBeNull();
    }
  });

  it("세션 쿠키가 없으면 서명하지 않는다", async () => {
    expect(await signStaffContext(ctx, [{ name: "other", value: "x" }], NOW)).toBeNull();
  });

  it("조직 ID와 역할이 짝이 안 맞거나 역할 값이 이상하면 서명돼 있어도 거부된다", async () => {
    const bad = [
      { ...ctx, orgRole: null },
      { ...ctx, orgRole: "superuser" as never },
      { ...ctx, userId: "" },
    ];

    for (const value of bad) {
      const token = await signStaffContext(value, sessionA, NOW);
      expect(await verifyStaffContext(token, sessionA, NOW)).toBeNull();
    }
  });
});
