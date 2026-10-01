/**
 * 성능·부하 가드 — 재고 보기가 열 때마다 부르는 shadow_box_stock(마이그레이션 192·196·197)이 박스 5,000개·상품 50개에서도 빠른지.
 * 대량 입고 직후에는 통계(ANALYZE)가 없어, 박스 집계 CTE가 상품마다 다시 계산되면(196) 2초대로 느려진다 — 197이 MATERIALIZED로 막는다.
 * 방금 시드한 데이터는 자동 통계 수집 전이므로 이 상태가 그대로 재현된다. 197을 196 본문으로 되돌리면 이 테스트가 실패한다.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";

const PRODUCTS = 50;
const BOXES = 5000;
const LIMIT_MS = 600;

let world: World;

beforeAll(async () => {
  world = await seedWorld();
  const admin = adminClient();

  const products = Array.from({ length: PRODUCTS }, (_, i) => ({
    wholesaler_id: world.wholesalerA,
    name: `냉장 한우 부하부위${Math.floor(i / 5)} ${["1++", "1+", "1", "2", "3"][i % 5]}`,
    category: "소",
    breed: "한우",
    subcategory: `부하부위${Math.floor(i / 5)}`,
    grade: ["1++", "1+", "1", "2", "3"][i % 5],
    origin: "국내산",
    storage_state: "냉장",
    base_price: 0,
    unit: "kg",
    stock_quantity: 0,
    is_active: false,
  }));

  const inserted = await admin.from("products").insert(products).select("id");

  expect(inserted.error).toBeNull();

  const ids = (inserted.data ?? []).map((row) => row.id as string);
  const boxes = Array.from({ length: BOXES }, (_, i) => ({
    wholesaler_id: world.wholesalerA,
    trace_no: `77${String(i).padStart(10, "0")}`,
    product_id: ids[i % ids.length],
    weight: 20,
    unit: "kg",
    scan_type: "MANUAL",
    status: "NORMAL",
    remaining_weight: 20,
  }));

  for (let i = 0; i < boxes.length; i += 500) {
    const { error } = await admin.from("inbound_scans").insert(boxes.slice(i, i + 500));

    expect(error, "박스 시드").toBeNull();
  }
}, 120_000);

describe("shadow_box_stock 규모 가드", () => {
  it(`박스 ${BOXES}개·상품 ${PRODUCTS}개(통계 없음)에서 ${LIMIT_MS}ms 안에 끝난다`, async () => {
    await actAs(world.users.ownerA);

    const started = performance.now();
    const { data, error } = await getActorClient().rpc("shadow_box_stock", { p_wholesaler_id: world.wholesalerA });
    const ms = Math.round(performance.now() - started);

    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(PRODUCTS);
    console.log(`shadow_box_stock ${BOXES}박스·${PRODUCTS}상품: ${ms}ms`);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it(`stock_box_combos는 박스 ${BOXES}개를 잘림 없이 합산하고 ${LIMIT_MS}ms 안에 끝난다(마이그 198)`, async () => {
    await actAs(world.users.ownerA);

    const started = performance.now();
    const { data, error } = await getActorClient().rpc("stock_box_combos", { p_wholesaler_id: world.wholesalerA });
    const ms = Math.round(performance.now() - started);

    expect(error).toBeNull();

    const rows = (data ?? []) as Array<{ boxes: number | string; weight: number | string }>;

    expect(rows.reduce((sum, row) => sum + Number(row.boxes), 0)).toBe(BOXES);
    expect(rows.reduce((sum, row) => sum + Number(row.weight), 0)).toBe(BOXES * 20);
    console.log(`stock_box_combos ${BOXES}박스: ${ms}ms (${rows.length}조합)`);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("다른 공급사의 박스 묶음은 못 본다", async () => {
    await actAs(world.users.ownerB);

    const { data } = await getActorClient().rpc("stock_box_combos", { p_wholesaler_id: world.wholesalerA });

    expect(data ?? []).toEqual([]);
  });
});
