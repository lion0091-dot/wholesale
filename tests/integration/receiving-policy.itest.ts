/**
 * 입고 수용 기준 설정 — 서버 액션 한 겹(역할 게이트·검증·저장) + 실제 DB(RLS·CHECK).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";
import { saveReceivingPolicyAction } from "@/app/dashboard/receiving-policy/actions";
import { DEFAULT_RECEIVING_POLICY, policyFromRow } from "@/lib/receiving-policy/policy";

let world: World;

const input = (patch: Partial<Parameters<typeof saveReceivingPolicyAction>[0]> = {}) => ({
  overToleranceMode: "PERCENT",
  overToleranceValue: "5",
  unlistedItemPolicy: "HOLD",
  ...patch,
});

const rowOf = async (wholesalerId: string) =>
  (await adminClient().from("receiving_policies").select("*").eq("wholesaler_id", wholesalerId).maybeSingle()).data as Record<string, unknown> | null;

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await adminClient().from("receiving_policies").delete().in("wholesaler_id", [world.wholesalerA, world.wholesalerB]);
  await world?.cleanup();
});

beforeEach(async () => {
  await actAs(world.users.ownerA);
});

describe("saveReceivingPolicyAction — 입고 기준 저장", () => {
  it("저장 전에는 행이 없어 기본값으로 읽히고, 저장하면 값이 들어가며 다시 저장하면 같은 행이 바뀐다", async () => {
    expect(await rowOf(world.wholesalerA)).toBeNull();
    expect(policyFromRow(null)).toEqual(DEFAULT_RECEIVING_POLICY);

    const first = await saveReceivingPolicyAction(input({ overToleranceValue: "5" }));

    expect(first.success).toBe(true);
    expect(first.data!.policy).toEqual({ overToleranceMode: "PERCENT", overToleranceValue: 5, unlistedItemPolicy: "HOLD" });
    expect(await rowOf(world.wholesalerA)).toMatchObject({ over_tolerance_mode: "PERCENT", unlisted_item_policy: "HOLD", updated_by: world.users.ownerA.id });

    const second = await saveReceivingPolicyAction(input({ overToleranceMode: "KG", overToleranceValue: "12.5", unlistedItemPolicy: "REJECT" }));

    expect(second.success).toBe(true);

    const { data: rows } = await adminClient().from("receiving_policies").select("*").eq("wholesaler_id", world.wholesalerA);

    expect(rows).toHaveLength(1);
    expect(Number(rows![0].over_tolerance_value)).toBe(12.5);
    expect(rows![0]).toMatchObject({ over_tolerance_mode: "KG", unlisted_item_policy: "REJECT" });
  });

  it("매니저는 저장할 수 있고, 직원·고객·비로그인은 거부되며 값이 안 바뀐다", async () => {
    await actAs(world.users.managerA);
    expect((await saveReceivingPolicyAction(input({ overToleranceValue: "3" }))).success).toBe(true);
    expect(Number((await rowOf(world.wholesalerA))!.over_tolerance_value)).toBe(3);

    for (const user of [world.users.staffA, world.users.retailerR, null]) {
      await actAs(user);

      const result = await saveReceivingPolicyAction(input({ overToleranceValue: "99" }));

      expect(result.success).toBe(false);
    }

    expect(Number((await rowOf(world.wholesalerA))!.over_tolerance_value)).toBe(3);
  });

  it("DB도 직원의 직접 쓰기를 막고(RLS), 직원은 자기 업체 기준을 읽을 수 있다", async () => {
    await saveReceivingPolicyAction(input({ overToleranceValue: "4" }));
    await actAs(world.users.staffA);

    const client = await getActorClient();
    const read = await client.from("receiving_policies").select("over_tolerance_value").eq("wholesaler_id", world.wholesalerA);

    expect(read.data).toHaveLength(1);

    const write = await client.from("receiving_policies").update({ over_tolerance_value: 50 }).eq("wholesaler_id", world.wholesalerA).select();

    expect(write.data ?? []).toHaveLength(0);
    expect(Number((await rowOf(world.wholesalerA))!.over_tolerance_value)).toBe(4);
  });

  it("다른 업체의 기준은 읽지도 바꾸지도 못한다", async () => {
    await actAs(world.users.ownerB);
    expect((await saveReceivingPolicyAction(input({ overToleranceValue: "9" }))).success).toBe(true);

    await actAs(world.users.ownerA);

    const client = await getActorClient();
    const otherRead = await client.from("receiving_policies").select("*").eq("wholesaler_id", world.wholesalerB);

    expect(otherRead.data ?? []).toHaveLength(0);

    const forged = await client.from("receiving_policies").upsert({ wholesaler_id: world.wholesalerB, over_tolerance_value: 1 }, { onConflict: "wholesaler_id" });

    expect(forged.error).not.toBeNull();
    expect(Number((await rowOf(world.wholesalerB))!.over_tolerance_value)).toBe(9);
    expect(Number((await rowOf(world.wholesalerA))!.over_tolerance_value)).toBe(4);
  });

  it("잘못된 값은 안내문으로 거부하고 저장하지 않으며, DB CHECK도 같은 값을 막는다", async () => {
    const before = await rowOf(world.wholesalerA);
    const cases: Array<[Partial<Parameters<typeof saveReceivingPolicyAction>[0]>, string]> = [
      [{ overToleranceValue: "-1" }, "0 이상"],
      [{ overToleranceValue: "abc" }, "0 이상"],
      [{ overToleranceValue: "101" }, "100 이하"],
      [{ overToleranceMode: "TON" }, "단위"],
      [{ unlistedItemPolicy: "ACCEPT" }, "없는 물건"],
    ];

    for (const [patch, expected] of cases) {
      const result = await saveReceivingPolicyAction(input(patch));

      expect(result.success, JSON.stringify(patch)).toBe(false);
      expect(result.error).toContain(expected);
    }

    expect(await rowOf(world.wholesalerA)).toEqual(before);

    const direct = await adminClient().from("receiving_policies").update({ over_tolerance_mode: "PERCENT", over_tolerance_value: 150 }).eq("wholesaler_id", world.wholesalerA);

    expect(direct.error?.code).toBe("23514");
  });
});
