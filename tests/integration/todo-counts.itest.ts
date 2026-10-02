/**
 * 종 배지 "지금 할 일" 집계 — /api/dashboard/todo-counts 가 실제 DB(RLS 포함)에서 맞게 세는지.
 * 다른 테스트가 같은 업체에 남긴 행이 있을 수 있어 절대값이 아니라 "시드 전후 차이"로 비교한다.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";
import { GET } from "@/app/api/dashboard/todo-counts/route";
import type { TodoCounts } from "@/lib/supplier/todo-counts";

let world: World;

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

async function readBody(): Promise<{ counts: TodoCounts | null; notices: unknown[] }> {
  const response = await GET();

  return (await response.json()) as { counts: TodoCounts | null; notices: unknown[] };
}

async function readCounts(): Promise<TodoCounts | null> {
  return (await readBody()).counts;
}

describe("종 배지 집계", () => {
  it("주문·취소요청·확인 필요 박스를 상태별로 센다", async () => {
    await actAs(world.users.ownerA);
    const before = await readCounts();

    expect(before).not.toBeNull();

    const product = await world.createProduct();
    const admin = adminClient();

    await world.createOrder({ product, status: "pending" });
    await world.createOrder({ product, status: "pending" });
    await world.createOrder({ product, status: "cancel_requested" });
    await world.createOrder({ product, status: "confirmed" });

    const scanTrace = world.newTraceNo();
    const { error } = await admin.from("inbound_scans").insert({
      id: randomUUID(),
      wholesaler_id: (await admin.from("products").select("wholesaler_id").eq("id", product.id).single()).data?.wholesaler_id,
      trace_no: scanTrace,
      weight: 5,
      unit: "kg",
      scan_type: "MANUAL",
      status: "EXCEPTION",
    });

    expect(error).toBeNull();

    const after = await readCounts();

    expect(after).toEqual({
      newOrders: before!.newOrders + 2,
      cancelRequests: before!.cancelRequests + 1,
      needsCheckBoxes: before!.needsCheckBoxes + 1,
      // 소비기한 임박·오래된 박스는 이 시나리오(주문·취소요청·확인 필요 박스)와 무관해 그대로다.
      expiringBoxes: before!.expiringBoxes,
    });

    await admin.from("inbound_scans").delete().eq("trace_no", scanTrace);
  });

  it("알림함(notices)은 대표에게는 배열로 오고 직원에게는 빈 배열, 비로그인은 counts null", async () => {
    const retailer = await world.createRetailer({ creditLimit: 10000 });

    await actAs(world.users.ownerA);
    expect((await getActorClient().from("wholesaler_retailers").update({ credit_limit: 20000 }).eq("id", retailer.relationshipId)).error).toBeNull();

    const owner = await readBody();

    expect(owner.notices.length).toBeGreaterThan(0);

    await actAs(world.users.staffA);
    expect((await readBody()).notices).toEqual([]);

    await actAs(null);
    expect(await readBody()).toEqual({ counts: null, notices: [] });
  });

  it("다른 업체 직원에게는 그 업체 것이 섞이지 않고, 매니저·직원도 같은 업체 숫자를 본다", async () => {
    await actAs(world.users.ownerA);
    const ownerView = await readCounts();

    await actAs(world.users.staffA);
    expect(await readCounts()).toEqual(ownerView);

    const product = await world.createProduct();

    await world.createOrder({ product, status: "pending" });

    await actAs(world.users.ownerB);
    const otherView = await readCounts();

    await actAs(world.users.ownerA);
    const ownerAfter = await readCounts();

    expect(ownerAfter!.newOrders).toBe(ownerView!.newOrders + 1);
    expect(otherView!.newOrders).not.toBe(ownerAfter!.newOrders);
  });

  it("고객·비로그인은 counts가 null이다", async () => {
    await actAs(world.users.retailerR);
    expect(await readCounts()).toBeNull();

    await actAs(null);
    expect(await readCounts()).toBeNull();
  });
});
