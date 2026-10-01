/** 입출고 내역 정렬 토글(마이그레이션 199) — 순서만 바뀌고 줄마다 붙는 그 시점 재고(balance_after)는 같아야 한다. */
import { beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";

let world: World;

beforeAll(async () => {
  world = await seedWorld();

  const product = await adminClient()
    .from("products")
    .insert({ wholesaler_id: world.wholesalerA, name: `정렬시험-${world.runId}`, category: "소", subcategory: `정렬부위${world.runId}`, origin: "국내산", storage_state: "냉장", breed: "한우", grade: "1+", base_price: 0, unit: "kg", stock_quantity: 0, is_active: false })
    .select("id")
    .single();

  expect(product.error).toBeNull();

  const rows = [10, -3, 5, -2].map((qty, i) => ({
    wholesaler_id: world.wholesalerA,
    product_id: product.data!.id,
    qty_delta: qty,
    event_type: "ADJUSTMENT",
    source_type: "manual",
    reason: `정렬${i}`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  }));

  const { error } = await adminClient().from("stock_ledger").insert(rows);

  expect(error).toBeNull();
});

type Row = { id: string; reason: string; balance_after: number | string };

async function list(newestFirst: boolean): Promise<Row[]> {
  await actAs(world.users.ownerA);

  const { data, error } = await getActorClient().rpc("list_stock_ledger", {
    p_wholesaler_id: world.wholesalerA,
    p_limit: 200,
    p_offset: 0,
    p_newest_first: newestFirst,
  });

  expect(error).toBeNull();

  return ((data ?? []) as Row[]).filter((row) => row.reason?.startsWith("정렬"));
}

describe("list_stock_ledger 정렬 토글", () => {
  it("최신순은 오래된 순의 정확한 역순이고 누적 재고 값은 그대로다", async () => {
    const oldest = await list(false);
    const newest = await list(true);

    expect(oldest.map((row) => row.reason)).toEqual(["정렬0", "정렬1", "정렬2", "정렬3"]);
    expect(newest.map((row) => row.reason)).toEqual(["정렬3", "정렬2", "정렬1", "정렬0"]);
    expect(oldest.map((row) => Number(row.balance_after))).toEqual([10, 7, 12, 10]);
    expect(newest.map((row) => Number(row.balance_after))).toEqual([10, 12, 7, 10]);
  });
});
