import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows: Array<{ id: string; endpoint: string; p256dh: string; auth: string }> = [];
const updated: Array<{ ids: string[]; patch: Record<string, unknown> }> = [];
const deleted: string[][] = [];
const sent: string[] = [];
/** endpoint별로 어떤 응답을 흉내 낼지 — 숫자는 WebPushError statusCode, 문자열은 일반 오류 */
const behavior = new Map<string, number | string>();

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
        const how = behavior.get(subscription.endpoint);

        if (typeof how === "number") throw new WebPushError("gone", how);
        if (typeof how === "string") throw new Error(how);

        sent.push(subscription.endpoint);

        return { statusCode: 201 };
      },
    },
  };
});

vi.mock("@/lib/supabase/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: (_cols: string, options?: { head?: boolean }) => ({
        eq: async () => (options?.head ? { count: rows.length } : { data: rows, error: null }),
      }),
      update: (patch: Record<string, unknown>) => ({
        in: async (_col: string, ids: string[]) => {
          updated.push({ ids, patch });

          return { error: null };
        },
      }),
      delete: () => ({
        in: async (_col: string, ids: string[]) => {
          deleted.push(ids);

          return { error: null };
        },
      }),
    }),
  }),
}));

import { isWebPushConfigured, sendWholesalerPush } from "./web-push";

const message = { title: "새 주문", body: "x", url: "/dashboard/orders" };

function configure() {
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "pub";
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "priv";
  process.env.WEB_PUSH_CONTACT = "mailto:a@b.c";
}

beforeEach(() => {
  rows.length = 0;
  updated.length = 0;
  deleted.length = 0;
  sent.length = 0;
  behavior.clear();
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  delete process.env.WEB_PUSH_CONTACT;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("웹푸시 발송", () => {
  it("키가 하나라도 없으면 미설정 — 아무것도 안 보내고 구독자 0으로 돌려준다", async () => {
    rows.push({ id: "1", endpoint: "https://p/1", p256dh: "k", auth: "a" });
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "pub";
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "priv";

    expect(isWebPushConfigured()).toBe(false);
    expect(await sendWholesalerPush("w", message)).toEqual({ subscribers: 0, accepted: 0, pruned: 0 });
    expect(sent).toEqual([]);
  });

  it("모든 구독에 보내고, 410·404는 지우고, 받은 것은 last_used_at을 찍는다", async () => {
    configure();
    rows.push(
      { id: "ok1", endpoint: "https://p/ok1", p256dh: "k", auth: "a" },
      { id: "gone", endpoint: "https://p/gone", p256dh: "k", auth: "a" },
      { id: "missing", endpoint: "https://p/missing", p256dh: "k", auth: "a" },
      { id: "ok2", endpoint: "https://p/ok2", p256dh: "k", auth: "a" }
    );
    behavior.set("https://p/gone", 410);
    behavior.set("https://p/missing", 404);

    const result = await sendWholesalerPush("w", message);

    expect(result).toEqual({ subscribers: 4, accepted: 2, pruned: 2 });
    expect(sent.sort()).toEqual(["https://p/ok1", "https://p/ok2"]);
    expect(deleted).toEqual([expect.arrayContaining(["gone", "missing"])]);
    expect(updated).toHaveLength(1);
    expect(updated[0].ids.sort()).toEqual(["ok1", "ok2"]);
    expect(typeof updated[0].patch.last_used_at).toBe("string");
  });

  it("일시 오류(5xx·네트워크)는 지우지 않고 넘어간다 — 다음 알림 때 다시 시도", async () => {
    configure();
    rows.push({ id: "flaky", endpoint: "https://p/flaky", p256dh: "k", auth: "a" }, { id: "ok", endpoint: "https://p/ok", p256dh: "k", auth: "a" });
    behavior.set("https://p/flaky", 503);

    const result = await sendWholesalerPush("w", message);

    expect(result).toEqual({ subscribers: 2, accepted: 1, pruned: 0 });
    expect(deleted).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("구독이 전부 죽어 있으면 accepted 0 — 호출부가 알림톡으로 간다", async () => {
    configure();
    rows.push({ id: "gone", endpoint: "https://p/gone", p256dh: "k", auth: "a" });
    behavior.set("https://p/gone", 410);

    expect(await sendWholesalerPush("w", message)).toEqual({ subscribers: 1, accepted: 0, pruned: 1 });
  });
});
