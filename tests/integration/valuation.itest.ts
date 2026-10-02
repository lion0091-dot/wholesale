/**
 * 원가 관리(재고 평가) — 규모 가드 + 실제 로그인 세션으로 본 권한(마이그레이션 210).
 * 박스 5,000개·상품 50개에서도 빠른지, 숫자가 맞는지, 대표/허용 안 된 직원/허용된 매니저/꺼진 업체가 의도대로 갈리는지.
 * 방금 시드한 데이터는 자동 통계 수집 전이므로 대량 입고 직후 상태가 그대로 재현된다.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";

const PRODUCTS = 50;
const BOXES = 5000;
const LIMIT_MS = 600;
const PRICE = 30000;

let world: World;

beforeAll(async () => {
  world = await seedWorld();
  const admin = adminClient();

  const products = Array.from({ length: PRODUCTS }, (_, i) => ({
    wholesaler_id: world.wholesalerA,
    name: `평가부하 ${i}`,
    category: "가공육",
    origin: "국내산",
    base_price: 0,
    unit: "kg",
    stock_quantity: 0,
    is_active: false,
  }));
  const inserted = await admin.from("products").insert(products).select("id");

  expect(inserted.error).toBeNull();

  const ids = (inserted.data ?? []).map((row) => row.id as string);
  // 5번째 박스마다 매입단가 없음 → 4,000박스가 단가 있음
  const boxes = Array.from({ length: BOXES }, (_, i) => ({
    wholesaler_id: world.wholesalerA,
    trace_no: `78${String(i).padStart(10, "0")}`,
    product_id: ids[i % ids.length],
    weight: 20,
    unit: "kg",
    scan_type: "MANUAL",
    status: "NORMAL",
    remaining_weight: 20,
    purchase_unit_price: i % 5 === 4 ? null : PRICE,
  }));

  for (let i = 0; i < boxes.length; i += 500) {
    const { error } = await admin.from("inbound_scans").insert(boxes.slice(i, i + 500));

    expect(error, "박스 시드").toBeNull();
  }
}, 120_000);

describe("get_inventory_valuation — 규모와 숫자", () => {
  it(`박스 ${BOXES}개·상품 ${PRODUCTS}개에서 ${LIMIT_MS}ms 안에 끝나고 합계가 정확하다`, async () => {
    await actAs(world.users.ownerA);

    const started = performance.now();
    const { data, error } = await getActorClient().rpc("get_inventory_valuation");
    const ms = Math.round(performance.now() - started);

    expect(error).toBeNull();

    const rows = (data ?? []) as Array<Record<string, number | string>>;

    expect(rows).toHaveLength(PRODUCTS);
    expect(rows.reduce((sum, row) => sum + Number(row.box_count), 0)).toBe(BOXES);
    expect(rows.reduce((sum, row) => sum + Number(row.remaining_qty), 0)).toBe(BOXES * 20);
    expect(rows.reduce((sum, row) => sum + Number(row.value_amount), 0)).toBe(4000 * 20 * PRICE);
    expect(rows.reduce((sum, row) => sum + Number(row.unpriced_qty), 0)).toBe(1000 * 20);
    console.log(`get_inventory_valuation ${BOXES}박스·${PRODUCTS}상품: ${ms}ms`);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("상품을 펼치면 박스를 오래된 순으로 최대 200개, 전체 개수와 함께 준다", async () => {
    await actAs(world.users.ownerA);

    const { data: summary } = await getActorClient().rpc("get_inventory_valuation");
    const productId = String((summary as Array<{ product_id: string }>)[0].product_id);

    const started = performance.now();
    const { data, error } = await getActorClient().rpc("get_inventory_valuation_boxes", { p_product_id: productId });
    const ms = Math.round(performance.now() - started);

    expect(error).toBeNull();

    const rows = (data ?? []) as Array<{ total_count: number | string }>;

    expect(rows.length).toBe(100); // 상품당 박스 100개(5,000 ÷ 50)
    expect(Number(rows[0].total_count)).toBe(100);
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});

describe("원가 관리 권한 — 실제 로그인 세션", () => {
  it("대표가 허용하지 않은 매니저·직원은 못 쓰고, 허용하면 쓴다(대표만 허용할 수 있다)", async () => {
    await actAs(world.users.managerA);
    expect((await getActorClient().rpc("get_inventory_valuation")).error).not.toBeNull();

    // 매니저가 스스로 허용하려 해도 거부
    const self = await getActorClient().rpc("set_feature_viewer", { p_key: "cost_management", p_user_id: world.users.managerA.id, p_allowed: true });

    expect(self.error?.message).toContain("FORBIDDEN");

    await actAs(world.users.ownerA);
    expect((await getActorClient().rpc("set_feature_viewer", { p_key: "cost_management", p_user_id: world.users.managerA.id, p_allowed: true })).error).toBeNull();

    await actAs(world.users.managerA);
    expect((await getActorClient().rpc("get_inventory_valuation")).error).toBeNull();

    await actAs(world.users.staffA);
    expect((await getActorClient().rpc("get_inventory_valuation")).error).not.toBeNull();
  });

  it("남의 업체 대표는 우리 업체의 재고 평가를 못 본다(자기 업체 것만 나온다)", async () => {
    await actAs(world.users.ownerB);

    const { data, error } = await getActorClient().rpc("get_inventory_valuation");

    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it("운영자가 업체의 기능을 끄면 대표도 못 쓴다", async () => {
    const off = await adminClient()
      .from("wholesaler_features")
      .upsert({ wholesaler_id: world.wholesalerA, feature_key: "cost_management", enabled: false });

    expect(off.error).toBeNull();

    await actAs(world.users.ownerA);

    const result = await getActorClient().rpc("get_inventory_valuation");

    expect(result.error?.message).toContain("FEATURE_DISABLED");
  });
});
