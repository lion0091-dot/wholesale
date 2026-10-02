/**
 * 알림벨 "소비기한 임박·오래된 박스"(마이그레이션 211) — 박스 5,000개에서도 빠르고, 목록 화면(get_expiring_boxes)과 숫자가 같고,
 * 남의 업체 박스는 안 센다. 벨은 화면을 옮길 때마다 부르므로 규모 가드를 둔다.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";

const BOXES = 5000;
const LIMIT_MS = 400;

let world: World;

function dayOffset(days: number): string {
  // KST 기준 날짜(DB의 CURRENT_DATE는 서버 시간대지만 하루 여유를 둔 값만 쓴다)
  const date = new Date(Date.now() + days * 86_400_000);

  return date.toISOString().slice(0, 10);
}

beforeAll(async () => {
  world = await seedWorld();
  const admin = adminClient();
  const product = await world.createProduct();

  // 100박스는 기한이 지났고(-3일), 400박스는 내일까지, 나머지는 한 달 뒤라 해당 없음. 4,000번째부터 일부는 다 나가서 잔량 0.
  const boxes = Array.from({ length: BOXES }, (_, i) => ({
    wholesaler_id: world.wholesalerA,
    trace_no: `79${String(i).padStart(10, "0")}`,
    product_id: product.id,
    weight: 20,
    unit: "kg",
    scan_type: "MANUAL",
    status: "NORMAL",
    remaining_weight: i >= 4900 ? 0 : 20,
    best_before: i < 100 ? dayOffset(-3) : i < 500 ? dayOffset(1) : dayOffset(30),
  }));

  for (let i = 0; i < boxes.length; i += 500) {
    const { error } = await admin.from("inbound_scans").insert(boxes.slice(i, i + 500));

    expect(error, "박스 시드").toBeNull();
  }
}, 120_000);

describe("count_expiring_boxes — 알림벨 숫자", () => {
  it(`박스 ${BOXES}개에서 ${LIMIT_MS}ms 안에 끝나고, 임박·지난 박스 500개만 센다`, async () => {
    await actAs(world.users.ownerA);

    const started = performance.now();
    const { data, error } = await getActorClient().rpc("count_expiring_boxes");
    const ms = Math.round(performance.now() - started);

    expect(error).toBeNull();
    expect(data).toBe(500);
    console.log(`count_expiring_boxes ${BOXES}박스: ${ms}ms`);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("목록 화면(get_expiring_boxes)과 같은 숫자다 — 정의가 한 곳이다", async () => {
    await actAs(world.users.ownerA);

    const count = await getActorClient().rpc("count_expiring_boxes");
    const list = await getActorClient().rpc("get_expiring_boxes");

    expect(list.error).toBeNull();
    expect((list.data ?? []).length).toBe(count.data);
  });

  it("직원도 같은 업체 박스를 센다(현장이 알아야 한다). 남의 업체 사람은 0이다", async () => {
    await actAs(world.users.staffA);
    expect((await getActorClient().rpc("count_expiring_boxes")).data).toBe(500);

    await actAs(world.users.ownerB);
    expect((await getActorClient().rpc("count_expiring_boxes")).data).toBe(0);
  });
});
