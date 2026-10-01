/**
 * 종 배지·고객 배송 벨의 Realtime 신호(마이그레이션 187) — 실제 로컬 Supabase Realtime에 구독해서
 * (1) 내 업체 주문·입고 박스 변화가 오고 (2) 남의 업체 변화는 RLS에 막혀 안 오고
 * (3) 고객은 자기 주문이 배송중으로 바뀌는 신호를 받는지 본다.
 * 화면 훅(lib/hooks/use-realtime-refresh.ts)과 같은 구독 모양(postgres_changes + 한 컬럼 필터)을 쓴다.
 */
import { randomUUID } from "node:crypto";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";

let world: World;
const channels: Array<{ client: SupabaseClient; channel: RealtimeChannel }> = [];

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await Promise.all(channels.map(({ client, channel }) => client.removeChannel(channel)));
  await world?.cleanup();
});

/**
 * 세션 클라이언트로 표 하나를 구독하고, 받은 이벤트를 모으는 배열을 돌려준다.
 * SUBSCRIBED 상태만으로는 부족하다 — Realtime이 DB 쪽 구독을 실제로 거는 건 그 뒤 "Subscribed to PostgreSQL"
 * 시스템 메시지 시점이라, 그 사이에 넣은 행은 못 받는다(처음에 이걸로 테스트가 들쭉날쭉했다). 그 메시지까지 기다린다.
 */
async function watch(client: SupabaseClient, table: string, filter: string): Promise<Array<Record<string, unknown>>> {
  const received: Array<Record<string, unknown>> = [];
  const channel = client.channel(`itest:${table}:${randomUUID()}`);

  channel.on("postgres_changes", { event: "*", schema: "public", table, filter }, (payload) => {
    received.push(payload.new as Record<string, unknown>);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${table} 구독이 10초 안에 안 붙었습니다`)), 10_000);

    channel.on("system", {}, (payload: { extension?: string; status?: string; message?: string }) => {
      if (payload.extension !== "postgres_changes") return;

      clearTimeout(timer);

      if (payload.status === "ok") resolve();
      else reject(new Error(`${table} DB 구독 실패: ${payload.message ?? ""}`));
    });

    channel.subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error(`${table} 구독 실패: ${status} ${err?.message ?? ""}`));
      }
    });
  });

  channels.push({ client, channel });

  return received;
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return check();
}

async function sessionOf(user: World["users"][keyof World["users"]]): Promise<SupabaseClient> {
  await actAs(user);

  return getActorClient();
}

describe("Realtime 신호 — 종 배지·고객 벨", () => {
  it("내 업체의 새 주문·확인 필요 박스는 바로 오고, 남의 업체 세션에는 안 온다", async () => {
    const ownerA = await sessionOf(world.users.ownerA);
    const ownerB = await sessionOf(world.users.ownerB);

    const mineOrders = await watch(ownerA, "orders", `wholesaler_id=eq.${world.wholesalerA}`);
    const mineScans = await watch(ownerA, "inbound_scans", `wholesaler_id=eq.${world.wholesalerA}`);
    // 업체 B 사장이 A의 변화를 몰래 구독해도 RLS가 막아야 한다.
    const spyOrders = await watch(ownerB, "orders", `wholesaler_id=eq.${world.wholesalerA}`);

    const product = await world.createProduct();
    const orderId = await world.createOrder({ product, status: "pending" });

    expect(await waitFor(() => mineOrders.some((row) => row.id === orderId), 5_000)).toBe(true);
    expect(mineOrders.find((row) => row.id === orderId)).toMatchObject({ status: "pending" });

    const scanId = randomUUID();
    const { error } = await adminClient().from("inbound_scans").insert({
      id: scanId,
      wholesaler_id: world.wholesalerA,
      trace_no: world.newTraceNo(),
      weight: 5,
      unit: "kg",
      scan_type: "MANUAL",
      status: "EXCEPTION",
    });

    expect(error).toBeNull();
    expect(await waitFor(() => mineScans.some((row) => row.id === scanId), 5_000)).toBe(true);

    // 반대쪽은 충분히 기다려도 아무것도 안 와야 한다.
    expect(await waitFor(() => spyOrders.length > 0, 2_000)).toBe(false);
  });

  it("고객은 자기 주문이 배송중으로 바뀌는 신호를 받는다", async () => {
    const retailer = await sessionOf(world.users.retailerR);
    const mine = await watch(retailer, "orders", `retailer_id=eq.${world.retailerR}`);

    const product = await world.createProduct();
    const orderId = await world.createOrder({ product, status: "confirmed" });

    const { error } = await adminClient().from("orders").update({ status: "shipping" }).eq("id", orderId);

    expect(error).toBeNull();
    expect(
      await waitFor(() => mine.some((row) => row.id === orderId && row.status === "shipping" && row.shipped_at), 5_000)
    ).toBe(true);
  });
});
