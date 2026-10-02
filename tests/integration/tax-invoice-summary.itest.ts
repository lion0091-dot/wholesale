/**
 * 계산서 집계 탭(마이그레이션 222·223) — 규모 가드 + 권한·섞임 확인.
 * 화면을 열 때마다 월별·거래처별·챙길 주문 함수 3개를 함께 부르므로, 주문 3,000건·발행이력 2,500건에서도 빠른지 본다.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";

const ORDERS = 3000;
const ISSUED = 2000;
const LIMIT_MS = 150;

let world: World;
const range = () => {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 300 * 86_400_000).toISOString().slice(0, 10);

  return { p_from: from, p_to: today };
};

beforeAll(async () => {
  world = await seedWorld();
  const admin = adminClient();
  const now = Date.now();
  const orders = Array.from({ length: ORDERS }, (_, i) => ({
    wholesaler_id: world.wholesalerA,
    retailer_id: world.retailerR,
    order_number: `TIS-${world.runId}-${i}`,
    total_amount: 10000 + i,
    status: "delivered",
    delivery_address: "서울",
    payment_method: "prepaid",
    shipment_finalized_at: new Date(now - (i % 250) * 86_400_000).toISOString(),
  }));
  const ids: Array<{ id: string; shipment_finalized_at: string }> = [];

  for (let i = 0; i < orders.length; i += 500) {
    const { data, error } = await admin.from("orders").insert(orders.slice(i, i + 500)).select("id, shipment_finalized_at");

    expect(error, "주문 시드").toBeNull();
    ids.push(...((data ?? []) as Array<{ id: string; shipment_finalized_at: string }>));
  }

  const issuances = ids.slice(0, ISSUED + 300).map((order, i) => ({
    order_id: order.id,
    wholesaler_id: world.wholesalerA,
    popbill_mgt_key: `TIS-${world.runId}-${i}`,
    status: i < ISSUED ? "issued" : i < ISSUED + 100 ? "pending" : "failed",
    issued_at: i < ISSUED ? order.shipment_finalized_at : null,
    created_at: order.shipment_finalized_at,
  }));

  for (let i = 0; i < issuances.length; i += 500) {
    const { error } = await admin.from("tax_invoice_issuances").insert(issuances.slice(i, i + 500));

    expect(error, "발행이력 시드").toBeNull();
  }
}, 180_000);

describe("계산서 집계 함수 규모 가드", () => {
  it(`월별·거래처별·챙길 주문이 주문 ${ORDERS}건에서 각각 ${LIMIT_MS}ms 안에 끝난다`, async () => {
    await actAs(world.users.ownerA);

    for (const fn of ["get_tax_invoice_by_month", "get_tax_invoice_by_retailer", "get_tax_invoice_todo"]) {
      const started = performance.now();
      const { data, error } = await getActorClient().rpc(fn, range());
      const ms = Math.round(performance.now() - started);

      expect(error, fn).toBeNull();
      expect((data ?? []).length, fn).toBeGreaterThan(0);
      console.log(`${fn} 주문 ${ORDERS}건: ${ms}ms`);
      expect(ms, fn).toBeLessThan(LIMIT_MS);
    }
  });

  it("챙길 주문은 상한 300건만 돌려주고 전체 건수는 total_count로 알려준다", async () => {
    await actAs(world.users.ownerA);

    const { data, error } = await getActorClient().rpc("get_tax_invoice_todo", range());
    const rows = (data ?? []) as Array<{ kind: string; total_count: number | string }>;

    expect(error).toBeNull();
    expect(rows.length).toBe(300);
    expect(Number(rows[0].total_count)).toBeGreaterThan(300);
    expect(rows[0].kind).toBe("pending");
  });

  it("매니저는 열 수 있고 직원·다른 공급사 대표는 못 본다", async () => {
    await actAs(world.users.managerA);
    expect((await getActorClient().rpc("get_tax_invoice_by_month", range())).error).toBeNull();

    await actAs(world.users.staffA);
    expect((await getActorClient().rpc("get_tax_invoice_by_month", range())).error?.message).toContain("NOT_MANAGER");
    expect((await getActorClient().rpc("get_tax_invoice_todo", range())).error?.message).toContain("NOT_MANAGER");

    await actAs(world.users.ownerB);

    const other = await getActorClient().rpc("get_tax_invoice_by_month", range());

    expect(other.error).toBeNull();
    expect(other.data ?? []).toHaveLength(0);
    expect(((await getActorClient().rpc("get_tax_invoice_todo", range())).data ?? []).length).toBe(0);
  });
});
