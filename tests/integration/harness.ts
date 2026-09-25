/**
 * 서버 액션 통합테스트 하네스 — 로컬 Docker Supabase 전용.
 *
 * - `actAs(user)`: 이후 서버 액션이 부르는 `createClient()`(mock)가 그 사용자로 로그인한 진짜 세션을 돌려준다.
 *   RLS·RPC·트리거는 실제 DB 그대로 동작한다. `actAs(null)`은 비로그인.
 * - 시드/정리는 service_role로 하고, 모든 행은 실행마다 새로 만든 UUID·이메일 접두어로 격리한다.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const PASSWORD = "itest-Passw0rd!";

let cachedAdmin: SupabaseClient | null = null;
let actor: SupabaseClient | null = null;
const sessionClients = new Map<string, SupabaseClient>();

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} 가 설정되지 않았습니다 — tests/integration/setup.ts 가 먼저 실행돼야 합니다.`);
  }

  return value;
}

function newClient(key: string): SupabaseClient {
  return createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function adminClient(): SupabaseClient {
  cachedAdmin ??= newClient(requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  return cachedAdmin;
}

/** 서버 액션이 부르는 createClient() 대역 — 현재 actAs 대상의 세션 클라이언트. */
export function getActorClient(): SupabaseClient {
  return actor ?? newClient(requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
}

export interface TestUser {
  id: string;
  email: string;
}

export async function actAs(user: TestUser | null): Promise<void> {
  if (!user) {
    actor = null;

    return;
  }

  let client = sessionClients.get(user.id);

  if (!client) {
    client = newClient(requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"));

    const { error } = await client.auth.signInWithPassword({ email: user.email, password: PASSWORD });

    if (error) {
      throw new Error(`테스트 사용자 로그인 실패(${user.email}): ${error.message}`);
    }

    sessionClients.set(user.id, client);
  }

  actor = client;
}

function must<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) {
    throw new Error(`시드 실패 — ${what}: ${result.error.message}`);
  }

  return result.data;
}

export interface WorldProduct {
  id: string;
  name: string;
}

export interface World {
  runId: string;
  users: {
    ownerA: TestUser;
    managerA: TestUser;
    staffA: TestUser;
    ownerB: TestUser;
    retailerR: TestUser;
  };
  wholesalerA: string;
  wholesalerB: string;
  retailerR: string;
  shopTokenA: string;
  shopTokenB: string;
  /** 공급사 A와 거래관계를 맺은 고객을 새로 만든다(기본: 거래중, 외상 불가, 프로필 완성). */
  createRetailer(options?: {
    status?: string;
    creditLimit?: number;
    outstanding?: number;
    allowedPaymentMethods?: string[];
    restaurantName?: string;
    deliveryAddress?: string;
    phone?: string;
  }): Promise<{ user: TestUser; retailerId: string; relationshipId: string }>;
  createProduct(overrides?: Record<string, unknown>): Promise<WorldProduct>;
  createOrder(options: {
    status?: string;
    product: WorldProduct;
    quantity?: number;
    unitPrice?: number;
    wholesalerId?: string;
    paymentMethod?: string;
    orderFields?: Record<string, unknown>;
  }): Promise<string>;
  /** 이번 실행 전용 12자리 이력번호(정리 대상으로 기록됨). prefix를 주면 그 앞자리 + 무작위 숫자(예: "1400770" → 같은 농장의 돼지 번호). */
  newTraceNo(prefix?: string): string;
  /** 공용 이력 캐시(master_livestock)에 시드 — 정부 API 조회 결과가 캐시에 들어 있는 상황. */
  seedTrace(
    traceNo: string,
    fields?: { part?: string | null; grade?: string | null; speciesGroup?: string | null; traceKind?: string; originCountry?: string | null }
  ): Promise<void>;
  /** 공급사 A의 명세서 한 장에 줄 하나(이력번호→상품)를 만든다. */
  createDocumentLine(options: {
    traceNo: string | null;
    /** 두 칸 서식(묶음번호+개체번호)의 묶음번호 칸 */
    lotNo?: string | null;
    product?: WorldProduct;
    partName?: string;
    grade?: string;
    status?: string;
  }): Promise<void>;
  cleanup(): Promise<void>;
}

async function createAuthUser(email: string, tracker: Tracker): Promise<TestUser> {
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`테스트 사용자 생성 실패(${email}): ${error?.message}`);
  }

  tracker.users.push(data.user.id);

  return { id: data.user.id, email };
}

/**
 * (seedWorld 가 감싸서 호출) 공급사 A(사장·매니저·직원)·공급사 B(사장)·고객 R(A와 거래중)을 새로 만든다.
 * 상품·주문은 테스트가 createProduct / createOrder 로 필요한 만큼 추가한다.
 */
async function buildWorld(tracker: Tracker): Promise<World> {
  const admin = adminClient();
  const runId = randomUUID().slice(0, 8);
  const email = (label: string) => `${label}-${runId}@itest.local`;

  const [ownerA, managerA, staffA, ownerB, retailerR] = await Promise.all([
    createAuthUser(email("owner-a"), tracker),
    createAuthUser(email("manager-a"), tracker),
    createAuthUser(email("staff-a"), tracker),
    createAuthUser(email("owner-b"), tracker),
    createAuthUser(email("retailer-r"), tracker),
  ]);

  const profiles = [
    { id: ownerA.id, role: "wholesaler", name: "A사장", is_supplier: true, is_verified: true },
    { id: managerA.id, role: "wholesaler", name: "A매니저", is_supplier: true, is_verified: true },
    { id: staffA.id, role: "wholesaler", name: "A직원", is_supplier: true, is_verified: true },
    { id: ownerB.id, role: "wholesaler", name: "B사장", is_supplier: true, is_verified: true },
    { id: retailerR.id, role: "retailer", name: "식당R", is_supplier: false, is_verified: false },
  ].map((profile) => ({ ...profile, phone: "01000000000" }));

  // auth.users INSERT 트리거가 미승인 wholesaler 프로필을 미리 만들고, 승인 컬럼 UPDATE는 트리거가 막는다.
  // 방금 만든 빈 프로필을 지우고 원하는 값으로 다시 INSERT 한다(INSERT는 막지 않음).
  must(await admin.from("profiles").delete().in("id", profiles.map((profile) => profile.id)), "profiles 초기화");
  must(await admin.from("profiles").insert(profiles), "profiles");

  const wholesalerA = randomUUID();
  const wholesalerB = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const retailerRowId = randomUUID();
  tracker.wholesalers.push(wholesalerA, wholesalerB);
  tracker.organizations.push(orgA, orgB);
  tracker.retailers.push(retailerRowId);
  const suffix = runId.replace(/\D/g, "").padEnd(8, "0").slice(0, 8);

  must(
    await admin.from("wholesalers").insert([
      {
        id: wholesalerA,
        profile_id: ownerA.id,
        business_name: `A축산-${runId}`,
        business_number: `91${suffix}`,
        representative_name: "A",
        status: "active",
      },
      {
        id: wholesalerB,
        profile_id: ownerB.id,
        business_name: `B축산-${runId}`,
        business_number: `92${suffix}`,
        representative_name: "B",
        status: "active",
      },
    ]),
    "wholesalers"
  );
  must(
    await admin.from("organizations").insert([
      { id: orgA, wholesaler_id: wholesalerA, name: `A축산-${runId}`, business_number: `91${suffix}` },
      { id: orgB, wholesaler_id: wholesalerB, name: `B축산-${runId}`, business_number: `92${suffix}` },
    ]),
    "organizations"
  );
  must(
    await admin.from("organization_staff").insert([
      { organization_id: orgA, user_id: ownerA.id, role: "owner" },
      { organization_id: orgA, user_id: managerA.id, role: "manager" },
      { organization_id: orgA, user_id: staffA.id, role: "staff" },
      { organization_id: orgB, user_id: ownerB.id, role: "owner" },
    ]),
    "organization_staff"
  );
  must(
    await admin.from("retailers").insert({
      id: retailerRowId,
      profile_id: retailerR.id,
      restaurant_name: `식당R-${runId}`,
      representative_name: "사장",
      delivery_address: "서울",
    }),
    "retailers"
  );
  must(
    await admin.from("wholesaler_retailers").insert({
      wholesaler_id: wholesalerA,
      retailer_id: retailerRowId,
      status: "active",
      outstanding_balance: 0,
      credit_limit: 1_000_000,
      allowed_payment_methods: ["prepaid", "on_credit"],
    }),
    "wholesaler_retailers"
  );

  const { data: tokenRows } = await admin.from("wholesalers").select("id, shop_token").in("id", [wholesalerA, wholesalerB]);
  const tokenOf = (id: string) => String(tokenRows?.find((row) => row.id === id)?.shop_token);

  const productIds: string[] = [];
  const orderIds: string[] = [];
  let retailerSeq = 0;

  return {
    runId,
    users: { ownerA, managerA, staffA, ownerB, retailerR },
    wholesalerA,
    wholesalerB,
    retailerR: retailerRowId,
    shopTokenA: tokenOf(wholesalerA),
    shopTokenB: tokenOf(wholesalerB),

    async createRetailer(options = {}) {
      retailerSeq += 1;

      const user = await createAuthUser(`retailer-x${retailerSeq}-${runId}@itest.local`, tracker);
      const retailerId = randomUUID();
      const relationshipId = randomUUID();

      must(await admin.from("profiles").delete().eq("id", user.id), "profiles 초기화");
      must(
        await admin.from("profiles").insert({
          id: user.id,
          role: "retailer",
          name: options.restaurantName ?? `식당X${retailerSeq}`,
          phone: options.phone ?? "01011112222",
          is_supplier: false,
          is_verified: false,
        }),
        "profiles"
      );
      tracker.retailers.push(retailerId);
      must(
        await admin.from("retailers").insert({
          id: retailerId,
          profile_id: user.id,
          restaurant_name: options.restaurantName ?? `식당X${retailerSeq}-${runId}`,
          representative_name: "사장",
          delivery_address: options.deliveryAddress ?? "서울 어딘가",
        }),
        "retailers"
      );
      must(
        await admin.from("wholesaler_retailers").insert({
          id: relationshipId,
          wholesaler_id: wholesalerA,
          retailer_id: retailerId,
          status: options.status ?? "active",
          outstanding_balance: options.outstanding ?? 0,
          credit_limit: options.creditLimit ?? 0,
          allowed_payment_methods: options.allowedPaymentMethods ?? ["prepaid"],
        }),
        "wholesaler_retailers"
      );

      return { user, retailerId, relationshipId };
    },

    async createProduct(overrides = {}) {
      const id = randomUUID();
      const name = `테스트상품-${runId}-${productIds.length + 1}`;

      must(
        await admin.from("products").insert({
          id,
          wholesaler_id: wholesalerA,
          name,
          category: "돼지",
          subcategory: "목살",
          origin: "국내산",
          base_price: 15000,
          unit: "kg",
          stock_quantity: 5,
          is_active: true,
          ...overrides,
        }),
        "products"
      );
      productIds.push(id);

      return { id, name };
    },

    async createOrder({ status = "pending", product, quantity = 1, unitPrice = 15000, wholesalerId, paymentMethod = "prepaid", orderFields = {} }) {
      const id = randomUUID();
      const total = unitPrice * quantity;

      must(
        await admin.from("orders").insert({
          id,
          wholesaler_id: wholesalerId ?? wholesalerA,
          retailer_id: retailerRowId,
          order_number: `ITEST-${runId}-${orderIds.length + 1}`,
          total_amount: total,
          status,
          delivery_address: "서울",
          payment_method: paymentMethod,
          ...orderFields,
        }),
        "orders"
      );
      orderIds.push(id);
      must(
        await admin.from("order_items").insert({
          order_id: id,
          product_id: product.id,
          product_name: product.name,
          unit_price: unitPrice,
          quantity,
          subtotal_amount: total,
        }),
        "order_items"
      );

      return id;
    },

    newTraceNo(prefix = "9") {
      const random = String(Math.floor(Math.random() * 1e11)).padStart(11, "0");
      const traceNo = `${prefix}${random}`.slice(0, 12);

      tracker.traces.push(traceNo);

      return traceNo;
    },

    async seedTrace(traceNo, fields = {}) {
      tracker.traces.push(traceNo);
      // upsert_master_livestock 은 service_role 전용 — 서버(lib/livestock/master-cache.ts)와 같은 경로다.
      const { error } = await admin.rpc("upsert_master_livestock", {
        p_trace_no: traceNo,
        p_trace_kind: fields.traceKind ?? "individual",
        p_source: "mtrace_livestock",
        p_raw_payload: {},
        p_species: "한우",
        p_species_group: fields.speciesGroup === undefined ? "소" : fields.speciesGroup,
        p_part_name: fields.part === undefined ? "등심" : fields.part,
        p_grade: fields.grade === undefined ? "1++" : fields.grade,
        p_slaughter_date: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
        p_butchery_place: "○○도축장",
        p_farm_name: null,
        p_origin_country: fields.originCountry ?? null,
        p_importer_name: null,
        p_packing_date: null,
      });

      if (error) {
        throw new Error(`시드 실패 — master_livestock: ${error.message}`);
      }
    },

    async createDocumentLine({ traceNo, lotNo = null, product, partName, grade, status = "PENDING" }) {
      const documentId = randomUUID();

      must(
        await admin.from("inbound_documents").insert({ id: documentId, wholesaler_id: wholesalerA, supplier_name: "테스트공급처", status }),
        "inbound_documents"
      );
      must(
        await admin.from("inbound_document_lines").insert({
          document_id: documentId,
          line_no: 1,
          item_name: product?.name ?? partName ?? "명세서 품목",
          product_id: product?.id ?? null,
          part_name: partName ?? null,
          grade: grade ?? null,
          trace_no: traceNo,
          lot_no: lotNo,
        }),
        "inbound_document_lines"
      );
    },

    async cleanup() {
      await purge(tracker);
    },
  };
}

/** 시드 도중 실패해도 이미 만든 사용자·행을 정리하도록 감싼다. */
export async function seedWorld(): Promise<World> {
  const tracker = newTracker();

  try {
    return await buildWorld(tracker);
  } catch (error) {
    await purge(tracker);

    throw error;
  }
}

interface Tracker {
  users: string[];
  wholesalers: string[];
  organizations: string[];
  retailers: string[];
  traces: string[];
}

function newTracker(): Tracker {
  return { users: [], wholesalers: [], organizations: [], retailers: [], traces: [] };
}

const uuidList = (ids: string[]) => (ids.length ? ids.map((id) => `'${id}'`).join(",") : "null");

/**
 * 테스트가 만든 행을 지운다. "마지막 owner는 삭제할 수 없다" 같은 무결성 트리거가 REST 삭제를 막으므로
 * 로컬 DB 컨테이너에 psql로 붙어 트리거를 끈 채(session_replication_role=replica) 지운다.
 * public 스키마의 wholesaler_id/organization_id/retailer_id/order_id/product_id 컬럼을 가진 테이블은 한꺼번에 훑고,
 * auth 쪽(identities·sessions)은 관리 API로 사용자를 지워 정리한다.
 */
async function purge(tracker: Tracker): Promise<void> {
  await actAs(null);
  sessionClients.clear();

  const container = process.env.INTEGRATION_DB_CONTAINER ?? "supabase_db_wholesale";
  const sql = `
begin;
set local session_replication_role = replica;
create temp table _w on commit drop as select id from public.wholesalers where id in (${uuidList(tracker.wholesalers)});
create temp table _o on commit drop as select id from public.organizations where id in (${uuidList(tracker.organizations)});
create temp table _r on commit drop as select id from public.retailers where id in (${uuidList(tracker.retailers)});
create temp table _ord on commit drop as select id from public.orders where wholesaler_id in (select id from _w);
create temp table _p on commit drop as select id from public.products where wholesaler_id in (select id from _w);
create temp table _t on commit drop as select unnest(array[${tracker.traces.length ? tracker.traces.map((trace) => `'${trace}'`).join(",") : "null"}]::text[]) as id;
do $$
declare r record; src text;
begin
  for r in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public'
      and c.column_name in ('wholesaler_id','organization_id','retailer_id','order_id','product_id','trace_no')
      and c.table_name not in ('wholesalers','organizations','retailers','orders','products','profiles')
  loop
    src := case r.column_name
      when 'wholesaler_id' then '_w' when 'organization_id' then '_o' when 'retailer_id' then '_r'
      when 'order_id' then '_ord' when 'trace_no' then '_t' else '_p' end;
    execute format('delete from public.%I where %I::text in (select id::text from %s)', r.table_name, r.column_name, src);
  end loop;
end $$;
delete from public.orders where id in (select id from _ord);
delete from public.products where id in (select id from _p);
delete from public.retailers where id in (select id from _r);
delete from public.organizations where id in (select id from _o);
delete from public.wholesalers where id in (select id from _w);
delete from public.profiles where id in (${uuidList(tracker.users)});
commit;
`;

  try {
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], {
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    console.warn(`[통합테스트 정리] DB 행 정리 실패: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const userId of tracker.users) {
    const { error } = await adminClient().auth.admin.deleteUser(userId);

    if (error) {
      console.warn(`[통합테스트 정리] 사용자 삭제 실패 ${userId}: ${error.message}`);
    }
  }
}
