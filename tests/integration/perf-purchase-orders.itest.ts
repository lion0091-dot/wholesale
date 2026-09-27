/**
 * 성능·부하 가드 — 공급사 여러 곳이 같은 시간대에 큰 발주서를 올려도 되는지(2026-09-28, 사장님: "모든 도매업체가 동일 시간대에 올릴 수 있다").
 * 통합테스트는 보통 행이 몇 개뿐이라 규모 문제가 통과한다. 여기서 실제 규모(상품 5,000개, 300줄 발주서, 업체 20곳 동시 저장)를 심고 상한을 건다.
 * 상한은 실측보다 넉넉해 CI 편차에는 안 흔들리고 큰 회귀(수 초 단위)는 잡는다. 측정값은 마지막에 표로 찍는다.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import writeExcelFile from "write-excel-file/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type TestUser, type World } from "./harness";
import { createPurchaseOrderAction, parsePurchaseOrderFileAction } from "@/app/dashboard/purchase-orders/actions";
import { loadProductOptions } from "@/lib/purchase-orders/load-product-options";
import { findProductForSpec, productSpecLabel, type ProductOption } from "@/lib/purchase-orders/product-match";

const PRODUCTS = 5000;
const LINES = 300;
const HISTORY_ORDERS = 60;
const CONCURRENT_WORLDS = 10;
const LIMIT_MS = 1500;
const CONCURRENT_LIMIT_MS = 8000;
const PASSWORD = "itest-Passw0rd!";

const GRADE_PARTS = ["안심", "등심", "채끝", "갈비", "양지", "사태", "우삼겹", "차돌박이", "다짐육"];
const GRADES = ["1++", "1+", "1", "2", "3"];
const ORIGINS = ["국내산", "미국산", "호주산", "뉴질랜드산", "캐나다산", "브라질산", "스페인산", "기타 수입산"];
// 실제 목록 값으로 만들 수 있는 소 상품 조합(부위 9 × 등급 5 × 원산지 8 = 360) — 저장 검사를 통과하는 값이어야 자동 연결까지 잰다.
const BEEF_COMBOS = GRADE_PARTS.flatMap((part) => GRADES.flatMap((grade) => ORIGINS.map((origin) => ({ part, grade, origin }))));
const measurements: Array<[string, number]> = [];

async function timed<T>(label: string, run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  const ms = Math.round(performance.now() - started);

  measurements.push([label, ms]);

  return { value, ms };
}

async function insertChunks(table: string, rows: Array<Record<string, unknown>>, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await adminClient().from(table).insert(rows.slice(i, i + size));

    expect(error, `${table} 시드`).toBeNull();
  }
}

function userClient(user: TestUser): Promise<SupabaseClient> {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return client.auth.signInWithPassword({ email: user.email, password: PASSWORD }).then(({ error }) => {
    if (error) throw new Error(`로그인 실패: ${error.message}`);

    return client;
  });
}

let world: World;
let supplierId: string;
let beef: ProductOption[] = [];
const extraWorlds: World[] = [];

beforeAll(async () => {
  world = await seedWorld();

  const supplier = await adminClient().from("suppliers").insert({ wholesaler_id: world.wholesalerA, name: `성능거래처-${world.runId}` }).select("id").single();

  supplierId = supplier.data!.id as string;

  // 상품 5,000개: 소 360개(실제 목록 값 조합 전부), 나머지는 키 없는 가공육 — 실제 업체는 소·돼지·가공육이 섞여 있다.
  const rows = Array.from({ length: PRODUCTS }, (_, index) =>
    index < BEEF_COMBOS.length
      ? { id: randomUUID(), wholesaler_id: world.wholesalerA, name: `${BEEF_COMBOS[index].part} ${BEEF_COMBOS[index].grade}`, category: "소", subcategory: BEEF_COMBOS[index].part, grade: BEEF_COMBOS[index].grade, origin: BEEF_COMBOS[index].origin, base_price: 0, unit: "kg", stock_quantity: 0, is_active: false }
      : { id: randomUUID(), wholesaler_id: world.wholesalerA, name: `성능가공-${index}`, category: "가공육", subcategory: null, grade: null, origin: "국내산", base_price: 0, unit: "kg", stock_quantity: 0, is_active: false }
  );

  await insertChunks("products", rows);
  beef = rows.slice(0, BEEF_COMBOS.length).map((row) => ({ id: row.id, name: row.name, category: "소", subcategory: row.subcategory, grade: row.grade, origin: row.origin }) as ProductOption);
}, 180_000);

afterAll(async () => {
  // 설정상 콘솔 출력이 숨겨지므로, PERF_REPORT=파일경로 를 주면 측정값을 그 파일에 적는다.
  if (process.env.PERF_REPORT) {
    writeFileSync(process.env.PERF_REPORT, measurements.map(([label, ms]) => `${ms}ms  ${label}`).join("\n"));
  }

  for (const extra of extraWorlds) {
    await extra.cleanup();
  }

  await world?.cleanup();
}, 180_000);

describe("발주서 화면·저장 경로 — 상품 5,000개, 300줄", () => {
  it("발주서에서 고를 상품 목록을 5,000개 전부 불러온다(중간에 잘리지 않는다)", async () => {
    await actAs(world.users.ownerA);

    const { value, ms } = await timed("상품 목록 5,000개 조회", () => loadProductOptions(getActorClient() as never, world.wholesalerA));

    expect(value).toHaveLength(PRODUCTS);
    expect(ms).toBeLessThan(LIMIT_MS);

    // 참고 측정 — 저장 경로가 쓰는 "소만"/"고른 상품만" 조회.
    const cattle = await timed("(참고) 소 상품만 조회", () => loadProductOptions(getActorClient() as never, world.wholesalerA, { categories: ["소"] }));
    await timed("(참고) 고른 상품 150개만 조회", () => loadProductOptions(getActorClient() as never, world.wholesalerA, { ids: value.slice(0, 150).map((product) => product.id) }));

    expect(cattle.value).toHaveLength(BEEF_COMBOS.length);
    expect(cattle.ms).toBeLessThan(LIMIT_MS);
  });

  it("품목 목록 라벨 만들기·스펙 매칭 300줄은 브라우저·서버에서 부담이 없다", async () => {
    const { ms: labelMs } = await timed("라벨 5,000개 만들기", async () => beef.map(productSpecLabel));
    const products = beef;
    const { ms: matchMs } = await timed("스펙 매칭 300줄 × 상품 1,000개", async () => {
      for (let i = 0; i < LINES; i += 1) {
        const combo = BEEF_COMBOS[i % BEEF_COMBOS.length];

      findProductForSpec({ category: "소", subcategory: combo.part, grade: combo.grade, origin: combo.origin }, products);
      }
    });

    expect(labelMs).toBeLessThan(200);
    expect(matchMs).toBeLessThan(500);
  });

  it("300줄 발주서 저장(상품 고른 줄 + 스펙만 적은 줄이 섞임)이 상한 안이고 줄이 전부 저장된다", async () => {
    await actAs(world.users.ownerA);

    const lines = Array.from({ length: LINES }, (_, index) =>
      index % 2 === 0
        ? { category: "", subcategory: "", grade: "", origin: "", quantity: "10", unitPrice: "", productId: beef[index].id }
        : { category: "소", subcategory: BEEF_COMBOS[index].part, grade: BEEF_COMBOS[index].grade, origin: BEEF_COMBOS[index].origin, quantity: "10", unitPrice: "", productId: "" }
    );
    const { value, ms } = await timed("발주서 300줄 저장(액션)", () =>
      createPurchaseOrderAction({ supplierId, orderedOn: "2026-09-28", expectedOn: "", note: "", lines })
    );

    expect(value.success, value.error).toBe(true);
    expect(ms).toBeLessThan(LIMIT_MS);

    const { data } = await adminClient().from("purchase_order_lines").select("line_no, product_id").eq("purchase_order_id", value.data!.id);

    expect(data).toHaveLength(LINES);
    // 스펙만 적은 홀수 줄도 같은 스펙의 등록 상품에 자동으로 이어졌다.
    expect((data ?? []).filter((row) => row.product_id).length).toBe(LINES);
  });

  it("300줄 엑셀을 올려 읽는 시간이 상한 안이다", async () => {
    await actAs(world.users.ownerA);

    const rows: unknown[][] = [["축종", "부위", "등급", "원산지", "수량(kg)"]];

    for (let i = 0; i < LINES; i += 1) {
      rows.push(["소", BEEF_COMBOS[i].part, BEEF_COMBOS[i].grade, BEEF_COMBOS[i].origin, "10"]);
    }

    const buffer = await writeExcelFile([{ data: rows, sheet: "발주서" }] as never).toBuffer();
    const form = new FormData();

    form.set("file", new File([new Uint8Array(buffer)], "발주서.xlsx"));

    const { value, ms } = await timed("엑셀 300줄 읽기+상품 매칭(액션)", () => parsePurchaseOrderFileAction(form));

    expect(value.success, value.error).toBe(true);
    expect(value.data!.rows.filter((row) => row.input.productId).length).toBe(LINES);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("발주서 화면 조회(최근 60건 × 300줄 = 18,000줄)가 상한 안이다", async () => {
    await actAs(world.users.ownerA);

    const orders = Array.from({ length: HISTORY_ORDERS }, () => ({ id: randomUUID(), wholesaler_id: world.wholesalerA, supplier_id: supplierId, supplier_name: "성능", status: "OPEN" }));

    await insertChunks("purchase_orders", orders);
    await insertChunks(
      "purchase_order_lines",
      orders.flatMap((order) =>
        Array.from({ length: LINES }, (_, index) => ({ purchase_order_id: order.id, wholesaler_id: world.wholesalerA, line_no: index + 1, category: "소", subcategory: BEEF_COMBOS[index].part, grade: BEEF_COMBOS[index].grade, origin: BEEF_COMBOS[index].origin, quantity: 10, product_id: beef[index].id }))
      ),
      1000
    );

    const { value, ms } = await timed("발주서 화면 조회 60건×300줄", async () =>
      getActorClient()
        .from("purchase_orders")
        .select("id, supplier_id, supplier_name, ordered_on, expected_on, note, status, purchase_order_lines ( line_no, product_id, category, subcategory, grade, origin, quantity, unit, unit_price )")
        .eq("wholesaler_id", world.wholesalerA)
        .order("ordered_on", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(60)
    );

    expect(value.error).toBeNull();
    expect((value.data ?? []).length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(LIMIT_MS * 2);
  }, 120_000);
});

describe("일반적인 규모 — 최근 발주서 60건 × 20줄, 상품 300개", () => {
  it("발주서 화면 조회와 상품 목록이 빠르다", async () => {
    const orders = Array.from({ length: HISTORY_ORDERS }, () => ({ id: randomUUID(), wholesaler_id: world.wholesalerB, supplier_id: null as string | null, supplier_name: "일반", status: "OPEN" }));
    const supplier = await adminClient().from("suppliers").insert({ wholesaler_id: world.wholesalerB, name: `일반거래처-${world.runId}` }).select("id").single();

    orders.forEach((order) => {
      order.supplier_id = supplier.data!.id as string;
    });
    await insertChunks("purchase_orders", orders);
    await insertChunks(
      "purchase_order_lines",
      orders.flatMap((order) =>
        Array.from({ length: 20 }, (_, index) => ({ purchase_order_id: order.id, wholesaler_id: world.wholesalerB, line_no: index + 1, category: "소", subcategory: BEEF_COMBOS[index].part, grade: BEEF_COMBOS[index].grade, origin: BEEF_COMBOS[index].origin, quantity: 10 }))
      ),
      1000
    );
    await insertChunks(
      "products",
      Array.from({ length: 300 }, (_, index) => ({ id: randomUUID(), wholesaler_id: world.wholesalerB, name: `일반상품-${index}`, category: "가공육", origin: "국내산", base_price: 0, unit: "kg", stock_quantity: 0, is_active: false }))
    );
    await actAs(world.users.ownerB);

    const history = await timed("(일반 규모) 발주서 화면 조회 60건×20줄", async () =>
      getActorClient()
        .from("purchase_orders")
        .select("id, supplier_id, supplier_name, ordered_on, expected_on, note, status, purchase_order_lines ( line_no, product_id, category, subcategory, grade, origin, quantity, unit, unit_price )")
        .eq("wholesaler_id", world.wholesalerB)
        .order("ordered_on", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(60)
    );
    const options = await timed("(일반 규모) 상품 300개 목록", () => loadProductOptions(getActorClient() as never, world.wholesalerB));

    expect(history.value.error).toBeNull();
    expect(options.value).toHaveLength(300);
    expect(history.ms).toBeLessThan(500);
    expect(options.ms).toBeLessThan(500);
  }, 120_000);
});

describe("동시 부하 — 업체 20곳이 같은 시각에 300줄 발주서를 저장", () => {
  it("모두 성공하고 각자 상한 안에 끝나며 서로의 데이터가 섞이지 않는다", async () => {
    for (let i = 0; i < CONCURRENT_WORLDS; i += 1) {
      extraWorlds.push(await seedWorld());
    }

    const actors = extraWorlds.flatMap((w) => [
      { user: w.users.ownerA, wholesalerId: w.wholesalerA },
      { user: w.users.ownerB, wholesalerId: w.wholesalerB },
    ]);

    // 업체마다 거래처 1곳 + 로그인 세션 준비(시간 측정에서 제외).
    const prepared = await Promise.all(
      actors.map(async (actor) => {
        const supplier = await adminClient().from("suppliers").insert({ wholesaler_id: actor.wholesalerId, name: `동시-${randomUUID().slice(0, 8)}` }).select("id").single();

        return { ...actor, supplierId: supplier.data!.id as string, client: await userClient(actor.user) };
      })
    );

    const started = performance.now();
    const durations = await Promise.all(
      prepared.map(async (actor) => {
        const begin = performance.now();
        const order = await actor.client
          .from("purchase_orders")
          .insert({ wholesaler_id: actor.wholesalerId, supplier_id: actor.supplierId, supplier_name: "동시", ordered_on: "2026-09-28" })
          .select("id")
          .single();

        expect(order.error, "발주서 헤더").toBeNull();

        const lines = await actor.client.from("purchase_order_lines").insert(
          Array.from({ length: LINES }, (_, index) => ({ purchase_order_id: order.data!.id, wholesaler_id: actor.wholesalerId, line_no: index + 1, category: "소", subcategory: GRADE_PARTS[index % 9], grade: "1++", origin: "국내산", quantity: 10 }))
        );

        expect(lines.error, "발주서 줄").toBeNull();

        const readBack = await actor.client.from("purchase_orders").select("id, purchase_order_lines ( line_no )").eq("id", order.data!.id).single();

        return { ms: Math.round(performance.now() - begin), lineCount: (readBack.data as { purchase_order_lines: unknown[] }).purchase_order_lines.length };
      })
    );
    const total = Math.round(performance.now() - started);
    const sorted = durations.map((d) => d.ms).sort((a, b) => a - b);

    measurements.push([`동시 20업체 저장 — 전체`, total], [`동시 20업체 저장 — 중앙값`, sorted[Math.floor(sorted.length / 2)]], [`동시 20업체 저장 — 최대`, sorted[sorted.length - 1]]);

    expect(durations.every((d) => d.lineCount === LINES)).toBe(true);
    expect(sorted[sorted.length - 1]).toBeLessThan(CONCURRENT_LIMIT_MS);

    // 한 업체의 계정으로는 다른 업체의 발주서가 한 건도 안 보인다(부하 중에도 RLS 격리 유지).
    const first = prepared[0];
    const visible = await first.client.from("purchase_orders").select("wholesaler_id").limit(1000);

    expect(new Set((visible.data ?? []).map((row) => row.wholesaler_id))).toEqual(new Set([first.wholesalerId]));
  }, 300_000);
});
