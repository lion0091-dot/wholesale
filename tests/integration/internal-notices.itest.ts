/**
 * 알림함 RPC(list_wholesaler_internal_notices, 마이그 188) — 실제 audit_log 트리거가 남긴 기록에서
 * 여신 한도·거래 상태 변경만 골라 처리자·거래처 이름을 붙이는지, 대표·매니저만 보고 직원·남의 업체는 못 보는지,
 * 그리고 이력이 수천 건 쌓여도 종 패널이 느려지지 않는지(규모 부하) 본다.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";
import { fetchInternalNotices } from "@/lib/supplier/internal-notices";

const PERF_ROWS = 3000;
const PERF_LIMIT_MS = 400;

let world: World;

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

describe("알림함 RPC", () => {
  it("여신 한도·거래 정지·재개가 처리자·거래처 이름과 함께 최신순으로 오고, 그 외 변경은 안 온다", async () => {
    const admin = adminClient();
    const retailer = await world.createRetailer({ restaurantName: `알림식당-${world.runId}`, creditLimit: 100000 });

    // 대표 세션으로 바꿔야 audit_log.changed_by에 대표가 찍힌다.
    await actAs(world.users.ownerA);
    const owner = getActorClient();

    expect((await owner.from("wholesaler_retailers").update({ credit_limit: 250000 }).eq("id", retailer.relationshipId)).error).toBeNull();
    // 메모만 바꾼 건 알림이 아니다.
    expect((await owner.from("wholesaler_retailers").update({ memo: "메모" }).eq("id", retailer.relationshipId)).error).toBeNull();
    expect((await owner.rpc("set_wholesaler_retailer_status", { p_retailer_id: retailer.retailerId, p_status: "blocked", p_reason: "대금 미납" })).error).toBeNull();
    expect((await owner.rpc("set_wholesaler_retailer_status", { p_retailer_id: retailer.retailerId, p_status: "active", p_reason: null })).error).toBeNull();

    const { data: ownerProfile } = await admin.from("profiles").select("name").eq("id", world.users.ownerA.id).single();
    const notices = (await fetchInternalNotices(owner, world.wholesalerA)).filter((n) => n.retailerId === retailer.retailerId);

    // credit_limit은 numeric이라 "100000.00"처럼 온다 — 화면 문구는 Number()로 읽으므로 숫자로 비교한다.
    const asNumber = (value: string | null) => (value && /^[\d.]+$/.test(value) ? Number(value) : value);

    expect(notices.map((n) => [n.kind, asNumber(n.oldValue), asNumber(n.newValue)])).toEqual([
      ["status", "blocked", "active"],
      ["status", "active", "blocked"],
      ["credit_limit", 100000, 250000],
    ]);
    expect(notices[1].reason).toBe("대금 미납");
    expect(notices[0].reason).toBeNull();
    expect(notices.every((n) => n.retailerName === `알림식당-${world.runId}`)).toBe(true);
    expect(notices.every((n) => n.actorName === ownerProfile?.name)).toBe(true);
  });

  it("매니저는 보고, 직원과 남의 업체 대표는 빈 결과", async () => {
    await actAs(world.users.managerA);
    expect((await fetchInternalNotices(getActorClient(), world.wholesalerA)).length).toBeGreaterThan(0);

    await actAs(world.users.staffA);
    expect(await fetchInternalNotices(getActorClient(), world.wholesalerA)).toEqual([]);

    await actAs(world.users.ownerB);
    expect(await fetchInternalNotices(getActorClient(), world.wholesalerA)).toEqual([]);
  });

  it(`이력이 ${PERF_ROWS}건 쌓여도 종 패널 조회는 ${PERF_LIMIT_MS}ms 안`, async () => {
    const admin = adminClient();
    const retailer = await world.createRetailer({ restaurantName: `부하식당-${world.runId}` });
    const base = { id: retailer.relationshipId, wholesaler_id: world.wholesalerA, retailer_id: retailer.retailerId, status: "active", credit_limit: 0 };

    // audit_log는 트리거만 쓰므로 service_role로 직접 심는다(2026-10-01, 표 자체는 INSERT 권한이 서버에만 있음).
    const rows = Array.from({ length: PERF_ROWS }, (_, i) => ({
      table_name: "wholesaler_retailers",
      row_id: retailer.relationshipId,
      action: "update",
      changed_by: world.users.ownerA.id,
      old_data: { ...base, credit_limit: i, memo: null },
      new_data: { ...base, credit_limit: i + 1, memo: null },
      created_at: new Date(Date.now() - i * 1000).toISOString(),
    }));

    for (let i = 0; i < rows.length; i += 500) {
      expect((await admin.from("audit_log").insert(rows.slice(i, i + 500))).error).toBeNull();
    }

    await actAs(world.users.ownerA);
    const owner = getActorClient();
    const started = performance.now();
    const notices = await fetchInternalNotices(owner, world.wholesalerA);
    const ms = performance.now() - started;

    expect(notices.length).toBe(10);
    expect(ms, `알림함 조회 ${Math.round(ms)}ms`).toBeLessThan(PERF_LIMIT_MS);

    // 심은 이력은 정리 대상이 아니라서 직접 지운다.
    await admin.from("audit_log").delete().eq("row_id", retailer.relationshipId);
    void randomUUID;
  });
});
