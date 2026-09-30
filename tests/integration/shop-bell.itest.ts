/**
 * 미니샵 알림벨(배송 시작, 마이그레이션 182) — 배송중이 된 순간만 shipped_at이 찍히고,
 * 벨은 본인 주문만 보여주며, 열어 본 뒤에는 새 알림이 사라진다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World } from "./harness";
import { loadShopBellAction, markShopBellSeenAction } from "@/app/shop/[shop_token]/actions";

let world: World;

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

beforeEach(async () => {
  await actAs(null);
});

async function order(retailerId: string, status: string): Promise<string> {
  const product = await world.createProduct();

  return world.createOrder({ product, status, orderFields: { retailer_id: retailerId } });
}

async function shippedAtOf(orderId: string): Promise<string | null> {
  const { data } = await adminClient().from("orders").select("shipped_at").eq("id", orderId).single();

  return (data?.shipped_at as string | null) ?? null;
}

describe("배송 시작 시각(shipped_at) 트리거", () => {
  it("배송중으로 바뀔 때만 찍히고, 이후 수정으로는 바뀌지 않는다", async () => {
    const retailer = await world.createRetailer();
    const orderId = await order(retailer.retailerId, "confirmed");

    expect(await shippedAtOf(orderId)).toBeNull();

    const admin = adminClient();

    await admin.from("orders").update({ status: "shipping" }).eq("id", orderId);
    const first = await shippedAtOf(orderId);

    expect(first).not.toBeNull();

    // 운송장 수정 같은 다른 변경, 그리고 shipped_at을 직접 덮어쓰려는 시도 모두 값이 유지된다.
    await admin.from("orders").update({ tracking_number: "1234567890", shipped_at: "2001-01-01T00:00:00Z" }).eq("id", orderId);

    expect(await shippedAtOf(orderId)).toBe(first);
  });
});

describe("알림벨 조회·확인 표시", () => {
  it("배송이 시작된 본인 주문만 보이고, 열어 본 뒤에는 새 알림이 0이 된다", async () => {
    const mine = await world.createRetailer();
    const other = await world.createRetailer();
    const admin = adminClient();

    const confirmedOnly = await order(mine.retailerId, "confirmed");
    const shipped = await order(mine.retailerId, "confirmed");
    const othersShipped = await order(other.retailerId, "confirmed");

    await admin.from("orders").update({ status: "shipping", courier_code: "kr.cjlogistics", tracking_number: "111222333" }).eq("id", shipped);
    await admin.from("orders").update({ status: "shipping" }).eq("id", othersShipped);

    await actAs(mine.user);

    const first = await loadShopBellAction(world.shopTokenA);

    expect(first.success, first.error).toBe(true);
    expect(first.data?.items.map((item) => item.orderId)).toEqual([shipped]);
    expect(first.data?.items[0]).toMatchObject({ courierCode: "kr.cjlogistics", trackingNumber: "111222333", isNew: true });
    expect(first.data?.unseenCount).toBe(1);
    expect(first.data?.items.some((item) => item.orderId === confirmedOnly || item.orderId === othersShipped)).toBe(false);

    expect((await markShopBellSeenAction(world.shopTokenA)).success).toBe(true);

    const second = await loadShopBellAction(world.shopTokenA);

    expect(second.data?.unseenCount).toBe(0);
    expect(second.data?.items).toHaveLength(1);
    expect(second.data?.items[0].isNew).toBe(false);

    // 새 배송이 시작되면 다시 새 알림으로 잡힌다.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await admin.from("orders").update({ status: "shipping" }).eq("id", confirmedOnly);

    const third = await loadShopBellAction(world.shopTokenA);

    expect(third.data?.unseenCount).toBe(1);
    expect(third.data?.items[0].orderId).toBe(confirmedOnly);
  });

  it("로그인하지 않았거나 거래 관계가 없으면 빈 벨을 돌려준다", async () => {
    const anonymous = await loadShopBellAction(world.shopTokenA);

    expect(anonymous).toMatchObject({ success: true, data: { items: [], unseenCount: 0 } });
  });
});
