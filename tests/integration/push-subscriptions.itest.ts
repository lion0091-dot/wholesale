/**
 * 웹푸시 구독(마이그 189) — RLS(내 행만, 내가 속한 업체만)와 채널 선택 규칙(접수된 푸시가 있으면 알림톡 생략,
 * 구독이 전부 죽었으면 지우고 알림톡)을 실제 DB로 본다. 브라우저 회사 서버는 흉내 낸다(web-push 모듈 mock).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";

/** endpoint별 흉내 — 숫자면 그 상태코드로 실패(410=구독 죽음), 없으면 접수 성공 */
const pushBehavior = new Map<string, number>();

vi.mock("web-push", () => {
  class WebPushError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  return {
    WebPushError,
    default: {
      sendNotification: async (subscription: { endpoint: string }) => {
        const code = pushBehavior.get(subscription.endpoint);

        if (code) throw new WebPushError("push failed", code);

        return { statusCode: 201 };
      },
    },
  };
});

vi.mock("@/lib/notifications/alimtalk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/notifications/alimtalk")>();

  return {
    ...original,
    sendOrderNotificationToWholesaler: vi.fn(async () => ({
      success: true,
      status: "sent",
      messageId: "ALIM-test",
      sentAt: "",
      templateTitle: "",
      formattedMessage: "",
    })),
  };
});

import { sendOrderNotificationToWholesaler } from "@/lib/notifications/alimtalk";
import { notifyWholesalerNewOrder } from "@/lib/notifications/wholesaler-alerts";
import { savePushSubscriptionAction, removePushSubscriptionAction } from "@/app/actions/push-subscription";

const alimtalk = vi.mocked(sendOrderNotificationToWholesaler);

// 테스트용 VAPID 키(web-push가 만든 형식 그대로, 실서비스와 무관). 발송은 가짜 주소라 실패하는 게 정상이다.
const TEST_VAPID = {
  publicKey: "BIpB2pO0a4b5nYkWvL1xP2sVbT5nUwvh3xS3o6VJRN0r7hFnL8kK6jXcZ5l2bQ4P3sN9mA1cD7eF0gH2iJ4kL6M",
  privateKey: "4N3t6pXzvQ1aS2dF5gH7jK9lZ0xC2vB4nM6qW8eR1tY",
};

let world: World;

function fakeSubscription(seed: string) {
  return {
    endpoint: `https://127.0.0.1:9/push/${seed}`,
    keys: { p256dh: `p256dh-${seed}`, auth: `auth-${seed}` },
  };
}

function orderPayload(wholesalerId: string) {
  return {
    wholesalerId,
    wholesalerName: "A축산",
    wholesalerPhone: "01012345678",
    restaurantName: "식당R",
    orderNumber: `ORD-${randomUUID().slice(0, 8)}`,
    itemsSummary: "한우 등심 1kg",
    totalAmount: 68000,
    deliveryAddress: "서울",
  };
}

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await adminClient().from("push_subscriptions").delete().in("wholesaler_id", [world.wholesalerA, world.wholesalerB]);
  await world?.cleanup();
});

beforeEach(() => {
  alimtalk.mockClear();
  pushBehavior.clear();
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  delete process.env.WEB_PUSH_CONTACT;
});

describe("웹푸시 구독 RLS", () => {
  it("키가 없으면 저장 액션이 거절하고, 키가 있으면 내 업체 행으로 저장된다", async () => {
    await actAs(world.users.staffA);

    expect((await savePushSubscriptionAction(fakeSubscription("nokey"))).success).toBe(false);

    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = TEST_VAPID.publicKey;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = TEST_VAPID.privateKey;
    process.env.WEB_PUSH_CONTACT = "mailto:test@example.com";

    // 브라우저가 줄 리 없는 값(https 아님·키 빠짐)은 저장 전에 거른다.
    expect((await savePushSubscriptionAction({ endpoint: "http://insecure/x", keys: { p256dh: "k", auth: "a" } })).success).toBe(false);
    expect((await savePushSubscriptionAction({ endpoint: "https://ok/x", keys: { p256dh: "", auth: "a" } })).success).toBe(false);

    const result = await savePushSubscriptionAction(fakeSubscription("staffA"));

    expect(result.success).toBe(true);

    const mine = await getActorClient().from("push_subscriptions").select("wholesaler_id, user_id");

    expect(mine.data).toEqual([{ wholesaler_id: world.wholesalerA, user_id: world.users.staffA.id }]);
  });

  it("같은 브라우저를 다른 계정이 켜면 그 계정 것으로 바뀐다(사무실 PC 공용)", async () => {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = TEST_VAPID.publicKey;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = TEST_VAPID.privateKey;
    process.env.WEB_PUSH_CONTACT = "mailto:test@example.com";

    await actAs(world.users.managerA);
    expect((await savePushSubscriptionAction(fakeSubscription("staffA"))).success).toBe(true);

    const { data } = await adminClient().from("push_subscriptions").select("user_id").eq("endpoint", fakeSubscription("staffA").endpoint).single();

    expect(data?.user_id).toBe(world.users.managerA.id);

    // 되돌려 둔다(뒤 테스트는 staffA 것으로 가정).
    await actAs(world.users.staffA);
    expect((await savePushSubscriptionAction(fakeSubscription("staffA"))).success).toBe(true);
  });

  it("남의 구독은 안 보이고, 남의 업체로는 못 넣는다", async () => {
    await actAs(world.users.ownerB);
    const other = getActorClient();

    expect((await other.from("push_subscriptions").select("id")).data).toEqual([]);

    const sneak = await other.from("push_subscriptions").insert({
      user_id: world.users.ownerB.id,
      wholesaler_id: world.wholesalerA,
      ...fakeSubscription("sneak").keys,
      endpoint: fakeSubscription("sneak").endpoint,
    });

    expect(sneak.error).not.toBeNull();
  });
});

describe("채널 선택 — 푸시 켠 사람 있으면 알림톡 생략", () => {
  it("키가 없으면 알림톡으로 간다", async () => {
    const result = await notifyWholesalerNewOrder(orderPayload(world.wholesalerA));

    expect(alimtalk).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("ALIM-test");
  });

  it("켠 브라우저가 있는 업체는 알림톡을 안 보내고, 없는 업체(B)는 보낸다", async () => {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = TEST_VAPID.publicKey;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = TEST_VAPID.privateKey;
    process.env.WEB_PUSH_CONTACT = "mailto:test@example.com";

    const forA = await notifyWholesalerNewOrder(orderPayload(world.wholesalerA));

    expect(alimtalk).not.toHaveBeenCalled();
    expect(forA.messageId.startsWith("PUSH-")).toBe(true);

    await notifyWholesalerNewOrder(orderPayload(world.wholesalerB));
    expect(alimtalk).toHaveBeenCalledTimes(1);
  });

  it("켠 브라우저가 전부 죽어 있으면(410) 그 자리에서 지우고 그 주문은 알림톡으로 간다", async () => {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = TEST_VAPID.publicKey;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = TEST_VAPID.privateKey;
    process.env.WEB_PUSH_CONTACT = "mailto:test@example.com";

    await actAs(world.users.staffA);
    expect((await savePushSubscriptionAction(fakeSubscription("dead"))).success).toBe(true);
    pushBehavior.set(fakeSubscription("staffA").endpoint, 410);
    pushBehavior.set(fakeSubscription("dead").endpoint, 410);

    await notifyWholesalerNewOrder(orderPayload(world.wholesalerA));

    expect(alimtalk).toHaveBeenCalledTimes(1);

    const { data: left } = await adminClient().from("push_subscriptions").select("endpoint").eq("wholesaler_id", world.wholesalerA);

    expect(left).toEqual([]);

    // 뒤 테스트를 위해 staffA 구독을 되살린다.
    expect((await savePushSubscriptionAction(fakeSubscription("staffA"))).success).toBe(true);
  });

  it("끄면 다시 알림톡으로 간다", async () => {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = TEST_VAPID.publicKey;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = TEST_VAPID.privateKey;
    process.env.WEB_PUSH_CONTACT = "mailto:test@example.com";

    await actAs(world.users.staffA);
    expect((await removePushSubscriptionAction(fakeSubscription("staffA").endpoint)).success).toBe(true);

    await notifyWholesalerNewOrder(orderPayload(world.wholesalerA));
    expect(alimtalk).toHaveBeenCalledTimes(1);
  });
});
