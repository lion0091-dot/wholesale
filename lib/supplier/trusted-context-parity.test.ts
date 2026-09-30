import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustedStaffContext } from "@/lib/auth/request-context";

/**
 * getSupplierAccount()/getSupplierScope()의 서명 컨텍스트 경로가 기존 전체 DB 조회와
 * 같은 결과를 내는지, 서명이 없거나 어긋나면 기존 조회 순서 그대로 폴백하는지 확인한다.
 * 가짜 Supabase 클라이언트가 호출된 쿼리를 순서대로 기록한다.
 */

type Row = Record<string, unknown>;

interface FakeDb {
  user: { id: string; email?: string; phone?: string; user_metadata: Row } | null;
  profiles: Row[];
  organization_staff: Row[];
  organizations: Row[];
  wholesalers: Row[];
}

const state: { db: FakeDb; log: string[]; trusted: TrustedStaffContext | null } = {
  db: null as unknown as FakeDb,
  log: [],
  trusted: null,
};

function fakeClient() {
  return {
    auth: {
      getUser: async () => {
        state.log.push("auth.getUser");
        return { data: { user: state.db.user }, error: null };
      },
    },
    from(table: keyof Omit<FakeDb, "user">) {
      return {
        select(columns: string) {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            async maybeSingle() {
              state.log.push(`${table}:${filters.map(([c]) => c).join(",")}`);
              const row = (state.db[table] as Row[]).find((r) =>
                filters.every(([c, v]) => r[c] === v)
              );
              if (!row) return { data: null, error: null };
              const projected: Row = {};
              for (const col of columns.split(",").map((c) => c.trim())) projected[col] = row[col] ?? null;
              return { data: projected, error: null };
            },
          };
          return builder;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));

vi.mock("@/lib/auth/rbac", () => ({
  getTrustedStaffContext: async () => state.trusted,
  // 실제 getOrgStaffContext와 같은 규칙: 서명값이 있으면 그걸, 없으면 DB에서.
  getOrgStaffContext: async () => {
    if (state.trusted) {
      const t = state.trusted;
      return {
        userId: t.userId,
        email: t.email,
        platformRole: t.platformRole,
        organizationId: t.organizationId,
        orgRole: t.orgRole,
        isSuperAdmin: t.platformRole === "super_admin",
      };
    }
    const user = state.db.user;
    if (!user) return null;
    const profile = state.db.profiles.find((p) => p.id === user.id);
    const staff = state.db.organization_staff.find((s) => s.user_id === user.id);
    return {
      userId: user.id,
      email: user.email ?? null,
      platformRole: (profile?.role as string) ?? null,
      organizationId: (staff?.organization_id as string) ?? null,
      orgRole: (staff?.role as string) ?? null,
      isSuperAdmin: profile?.role === "super_admin",
    };
  },
}));

const { getSupplierAccount } = await import("./verification");
const { getSupplierScope } = await import("./scope");

/** 미들웨어(middleware.ts)가 서명하는 것과 같은 방식으로 DB에서 컨텍스트를 만든다. */
function trustedFromDb(db: FakeDb): TrustedStaffContext {
  const user = db.user!;
  const profile = db.profiles.find((p) => p.id === user.id);
  const staff = db.organization_staff.find((s) => s.user_id === user.id);
  const org = staff ? db.organizations.find((o) => o.id === staff.organization_id) : undefined;
  const wholesaler = org ? db.wholesalers.find((w) => w.id === org.wholesaler_id) : undefined;
  return {
    userId: user.id,
    email: user.email ?? null,
    platformRole: (profile?.role as TrustedStaffContext["platformRole"]) ?? null,
    organizationId: staff ? (staff.organization_id as string) : null,
    orgRole: staff ? (staff.role as TrustedStaffContext["orgRole"]) : null,
    displayName: "표시용",
    organization: staff
      ? {
          name: (org?.name as string) ?? null,
          wholesalerId: (org?.wholesaler_id as string) ?? null,
          subscriptionStatus: (wholesaler?.subscription_status as "active") ?? null,
        }
      : null,
  };
}

function wholesalerRow(id: string, profileId: string, extra: Row = {}): Row {
  return {
    id,
    profile_id: profileId,
    business_name: `상호-${id}`,
    business_number: "1234567890",
    representative_name: "대표",
    business_address: "서울",
    business_start_date: "2020-01-01",
    business_license_path: null,
    business_license_uploaded_at: null,
    shop_thumbnail_url: null,
    shop_token: `tok-${id}`,
    status: "active",
    subscription_status: "active",
    ...extra,
  };
}

const scenarios: Record<string, () => FakeDb> = {
  "조직 직원(조직→업체 연결)": () => ({
    user: { id: "u1", email: "a@x", user_metadata: { nickname: "카카오" }, phone: "010" },
    profiles: [{ id: "u1", role: "wholesaler", name: "직원", phone: null, is_supplier: true, is_verified: true, terms_agreed_at: "2026-01-01" }],
    organization_staff: [{ user_id: "u1", organization_id: "o1", role: "staff" }],
    organizations: [{ id: "o1", name: "조직", wholesaler_id: "w1" }],
    wholesalers: [wholesalerRow("w1", "owner-other"), wholesalerRow("w-own", "u1")],
  }),
  "조직 연결 업체 없음 → 본인 소유 업체": () => ({
    user: { id: "u2", user_metadata: {} },
    profiles: [{ id: "u2", role: "wholesaler", name: null, phone: null, is_supplier: true, is_verified: false, terms_agreed_at: null }],
    organization_staff: [{ user_id: "u2", organization_id: "o2", role: "owner" }],
    organizations: [{ id: "o2", name: "조직2", wholesaler_id: null }],
    wholesalers: [wholesalerRow("w2", "u2", { status: "pending" })],
  }),
  "조직 미소속 슈퍼관리자(과거 업체 행 있음)": () => ({
    user: { id: "sa", email: "sa@x", user_metadata: {} },
    profiles: [{ id: "sa", role: "super_admin", name: "관리자", phone: null, is_supplier: false, is_verified: false, terms_agreed_at: null }],
    organization_staff: [],
    organizations: [],
    wholesalers: [wholesalerRow("w-sa", "sa")],
  }),
  "조직 소속 슈퍼관리자": () => ({
    user: { id: "sa2", user_metadata: {} },
    profiles: [{ id: "sa2", role: "super_admin", name: "겸용", phone: null, is_supplier: true, is_verified: false, terms_agreed_at: "2026-01-01" }],
    organization_staff: [{ user_id: "sa2", organization_id: "o3", role: "owner" }],
    organizations: [{ id: "o3", name: "조직3", wholesaler_id: "w3" }],
    wholesalers: [wholesalerRow("w3", "sa2")],
  }),
  "업체 행이 없는 신규 계정": () => ({
    user: { id: "u4", user_metadata: {} },
    profiles: [{ id: "u4", role: "wholesaler", name: null, phone: null, is_supplier: true, is_verified: false, terms_agreed_at: null }],
    organization_staff: [],
    organizations: [],
    wholesalers: [],
  }),
};

async function run<T>(fn: () => Promise<T>, trusted: TrustedStaffContext | null) {
  state.trusted = trusted;
  state.log = [];
  const result = await fn();
  return { result, log: [...state.log] };
}

describe("getSupplierAccount — 서명 컨텍스트 경로", () => {
  for (const [name, make] of Object.entries(scenarios)) {
    it(`${name}: 폴백과 같은 결과, 조직 조회 생략`, async () => {
      state.db = make();
      const fallback = await run(getSupplierAccount, null);
      const fast = await run(getSupplierAccount, trustedFromDb(state.db));

      expect(fast.result).toEqual(fallback.result);
      expect(fast.log.some((q) => q.startsWith("organization_staff") || q.startsWith("organizations"))).toBe(false);
    });
  }

  it("서명 없음: 기존 조회 순서 그대로", async () => {
    state.db = scenarios["조직 직원(조직→업체 연결)"]();
    const { log } = await run(getSupplierAccount, null);

    expect(log).toEqual([
      "auth.getUser",
      "profiles:id",
      "organization_staff:user_id",
      "organizations:id",
      "wholesalers:id",
    ]);
  });

  it("서명 사용자와 세션 사용자가 다르면 전체 조회로 폴백", async () => {
    state.db = scenarios["조직 직원(조직→업체 연결)"]();
    const fallback = await run(getSupplierAccount, null);
    const forged = { ...trustedFromDb(state.db), userId: "someone-else", organizationId: "o-x", organization: { name: null, wholesalerId: "w-own", subscriptionStatus: null } };
    const fast = await run(getSupplierAccount, forged);

    expect(fast.result).toEqual(fallback.result);
    expect(fast.log).toContain("organization_staff:user_id");
  });

  it("세션 사용자가 없으면 null", async () => {
    state.db = scenarios["조직 직원(조직→업체 연결)"]();
    const trusted = trustedFromDb(state.db);
    state.db.user = null;

    expect((await run(getSupplierAccount, trusted)).result).toBeNull();
  });

  it("조직 소속인데 조직 정보가 비면 전체 조회로 폴백", async () => {
    state.db = scenarios["조직 직원(조직→업체 연결)"]();
    const fallback = await run(getSupplierAccount, null);
    const fast = await run(getSupplierAccount, { ...trustedFromDb(state.db), organization: null });

    expect(fast.result).toEqual(fallback.result);
    expect(fast.log).toContain("organizations:id");
  });
});

describe("getSupplierScope — 서명 컨텍스트 경로", () => {
  for (const [name, make] of Object.entries(scenarios)) {
    it(`${name}: 폴백과 같은 결과, organizations 조회 생략`, async () => {
      state.db = make();
      const fallback = await run(getSupplierScope, null);
      const fast = await run(getSupplierScope, trustedFromDb(state.db));

      expect(fast.result).toEqual(fallback.result);
      expect(fast.log.some((q) => q.startsWith("organizations"))).toBe(false);
    });
  }

  it("서명 없음: 기존 조회 순서 그대로", async () => {
    state.db = scenarios["조직 직원(조직→업체 연결)"]();
    const { log } = await run(getSupplierScope, null);

    expect(log).toEqual(["organizations:id", "wholesalers:id"]);
  });
});
