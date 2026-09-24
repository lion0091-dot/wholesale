/**
 * 4. 출고·주문 — 서버 액션 한 겹(입력 검증·역할 게이트·문구·환불 흐름) + 실제 DB(RLS·트리거).
 * DB 함수 레벨 검증은 scripts/db-test-orders-outbound.sql 이 이미 한다. 여기서는 그 위의 앱 로직만 본다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actAs, adminClient, seedWorld, type World } from "./harness";

vi.mock("@/lib/payments/tosspayments-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/payments/tosspayments-client")>();

  return { ...original, cancelPayment: vi.fn() };
});

import { cancelPayment, TossPaymentsError } from "@/lib/payments/tosspayments-client";
import { encryptCredential } from "@/lib/security/credential-crypto";
import {
  getHistoricalOrdersAction,
  updateOrderStatusAction,
  updateOrderTrackingAction,
} from "@/app/dashboard/orders/actions";

const cancelPaymentMock = vi.mocked(cancelPayment);

let world: World;

async function orderRow(orderId: string) {
  const { data } = await adminClient()
    .from("orders")
    .select("status, payment_status, courier_code, tracking_number")
    .eq("id", orderId)
    .single();

  return data as { status: string; payment_status: string | null; courier_code: string | null; tracking_number: string | null };
}

async function stockOf(productId: string): Promise<number> {
  const { data } = await adminClient().from("products").select("stock_quantity").eq("id", productId).single();

  return Number(data?.stock_quantity);
}

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

beforeEach(async () => {
  cancelPaymentMock.mockReset();
  await actAs(world.users.ownerA);
});

describe("updateOrderStatusAction — 권한·입력 게이트", () => {
  it("비로그인은 거부된다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product });

    await actAs(null);
    const result = await updateOrderStatusAction(orderId, "confirmed");

    expect(result.success).toBe(false);
    expect(result.error).toContain("로그인");
    expect((await orderRow(orderId)).status).toBe("pending");
  });

  it("고객(소매) 계정은 공급사 액션을 못 쓴다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product });

    await actAs(world.users.retailerR);
    const result = await updateOrderStatusAction(orderId, "confirmed");

    expect(result.success).toBe(false);
    expect((await orderRow(orderId)).status).toBe("pending");
  });

  it("다른 공급사 사장은 남의 발주를 못 바꾼다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product });

    await actAs(world.users.ownerB);
    const result = await updateOrderStatusAction(orderId, "confirmed");

    expect(result.success).toBe(false);
    expect((await orderRow(orderId)).status).toBe("pending");
  });

  it("UUID 형식이 아닌 ID는 DB를 치기 전에 거부한다", async () => {
    const result = await updateOrderStatusAction("not-a-uuid", "confirmed");

    expect(result).toEqual({ success: false, error: "올바른 발주 식별자가 아닙니다." });
  });

  it("정의되지 않은 상태값은 거부한다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product });

    const result = await updateOrderStatusAction(orderId, "hacked" as never);

    expect(result).toEqual({ success: false, error: "변경할 수 없는 발주 상태입니다." });
  });

  it("공급사는 취소 '요청' 상태를 만들 수 없다(바이어 전용)", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product });

    const result = await updateOrderStatusAction(orderId, "cancel_requested");

    expect(result.success).toBe(false);
    expect(result.error).toContain("고객(소매)");
    expect((await orderRow(orderId)).status).toBe("pending");
  });

  it("존재하지 않는 발주는 '찾을 수 없다'", async () => {
    const result = await updateOrderStatusAction("00000000-0000-4000-8000-000000000000", "confirmed");

    expect(result).toEqual({ success: false, error: "해당 발주서를 찾을 수 없습니다." });
  });
});

describe("updateOrderStatusAction — 상태 전이와 재고", () => {
  it("사장이 접수대기 발주를 확정하면 상태가 바뀌고 재고가 차감된다", async () => {
    const product = await world.createProduct({ stock_quantity: 5 });
    const orderId = await world.createOrder({ product, quantity: 2 });

    const result = await updateOrderStatusAction(orderId, "confirmed");

    expect(result).toEqual({ success: true, data: { status: "confirmed" } });
    expect((await orderRow(orderId)).status).toBe("confirmed");
    expect(await stockOf(product.id)).toBe(3);
  });

  it("직원(staff)도 발주 확정을 처리할 수 있다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product });

    await actAs(world.users.staffA);
    const result = await updateOrderStatusAction(orderId, "confirmed");

    expect(result.success).toBe(true);
    expect((await orderRow(orderId)).status).toBe("confirmed");
  });

  it("재고가 모자라면 확정이 막히고 사람이 읽을 문구가 나온다(날것의 DB 오류 아님)", async () => {
    const product = await world.createProduct({ stock_quantity: 5 });
    const orderId = await world.createOrder({ product, quantity: 20 });

    const result = await updateOrderStatusAction(orderId, "confirmed");

    expect(result.success).toBe(false);
    expect(result.error).toContain("재고가 부족해 확정할 수 없습니다");
    expect(result.error).toContain(product.name);
    expect(result.error).not.toContain("INSUFFICIENT_STOCK");
    expect((await orderRow(orderId)).status).toBe("pending");
    expect(await stockOf(product.id)).toBe(5);
  });

  it("확정 후 취소하면 차감됐던 재고가 돌아온다", async () => {
    const product = await world.createProduct({ stock_quantity: 5 });
    const orderId = await world.createOrder({ product, quantity: 2 });

    expect((await updateOrderStatusAction(orderId, "confirmed")).success).toBe(true);
    expect(await stockOf(product.id)).toBe(3);

    const cancelled = await updateOrderStatusAction(orderId, "cancelled");

    expect(cancelled.success).toBe(true);
    expect((await orderRow(orderId)).status).toBe("cancelled");
    expect(await stockOf(product.id)).toBe(5);
  });

  it("허용되지 않는 전이(배송완료 → 접수대기)는 거부한다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product, status: "delivered" });

    const result = await updateOrderStatusAction(orderId, "pending");

    expect(result).toEqual({ success: false, error: "현재 상태에서는 해당 처리를 진행할 수 없습니다." });
    expect((await orderRow(orderId)).status).toBe("delivered");
  });

  it("이미 그 상태면 아무것도 바꾸지 않고 성공으로 돌려준다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product, status: "confirmed" });

    const result = await updateOrderStatusAction(orderId, "confirmed");

    expect(result).toEqual({ success: true, data: { status: "confirmed" } });
  });
});

describe("updateOrderStatusAction — PG 결제 주문 취소(환불)", () => {
  async function seedPgOrder() {
    const product = await world.createProduct();
    const orderId = await world.createOrder({
      product,
      paymentMethod: "pg",
      orderFields: { payment_status: "paid", pg_payment_key: `pay_${world.runId}_${Math.random()}` },
    });

    return orderId;
  }

  it("PG 시크릿키가 없으면 환불을 못 하므로 취소도 막는다", async () => {
    const orderId = await seedPgOrder();

    const result = await updateOrderStatusAction(orderId, "cancelled");

    expect(result.success).toBe(false);
    expect(result.error).toContain("PG 연동 설정");
    expect(cancelPaymentMock).not.toHaveBeenCalled();
    expect((await orderRow(orderId)).status).toBe("pending");
  });

  it("환불이 성공해야 취소되고 결제 상태가 refunded로 남는다", async () => {
    await adminClient()
      .from("wholesalers")
      .update({ pg_secret_key_encrypted: encryptCredential("test_sk_secret") })
      .eq("id", world.wholesalerA);
    const orderId = await seedPgOrder();
    cancelPaymentMock.mockResolvedValue({} as never);

    const result = await updateOrderStatusAction(orderId, "cancelled");

    expect(result.success).toBe(true);
    expect(cancelPaymentMock).toHaveBeenCalledTimes(1);
    expect(cancelPaymentMock.mock.calls[0][0].secretKey).toBe("test_sk_secret");

    const row = await orderRow(orderId);

    expect(row.status).toBe("cancelled");
    expect(row.payment_status).toBe("refunded");
  });

  it("환불이 실패하면 취소 처리 자체를 막는다(돈은 그대로, 상태만 취소되는 사고 방지)", async () => {
    await adminClient()
      .from("wholesalers")
      .update({ pg_secret_key_encrypted: encryptCredential("test_sk_secret") })
      .eq("id", world.wholesalerA);
    const orderId = await seedPgOrder();
    cancelPaymentMock.mockRejectedValue(new TossPaymentsError("이미 취소된 결제입니다", "ALREADY_CANCELED"));

    const result = await updateOrderStatusAction(orderId, "cancelled");

    expect(result.success).toBe(false);
    expect(result.error).toContain("환불 처리에 실패");

    const row = await orderRow(orderId);

    expect(row.status).toBe("pending");
    expect(row.payment_status).toBe("paid");
  });
});

describe("updateOrderTrackingAction", () => {
  it("확정된 발주에 운송장을 넣으면 배송중으로 자동 전환된다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product, status: "confirmed" });

    const result = await updateOrderTrackingAction(orderId, "04", " 1234567890 ");

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ trackingNumber: "1234567890", status: "shipping", verification: "skipped_not_configured" });

    const row = await orderRow(orderId);

    expect(row.status).toBe("shipping");
    expect(row.tracking_number).toBe("1234567890");
    expect(row.courier_code).toBe("04");
  });

  it("접수대기 발주는 운송장만 저장하고 상태는 그대로 둔다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product, status: "pending" });

    const result = await updateOrderTrackingAction(orderId, "04", "555");

    expect(result.success).toBe(true);
    expect((await orderRow(orderId)).status).toBe("pending");
  });

  it("지원하지 않는 택배사와 빈 운송장번호는 거부한다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product, status: "confirmed" });

    expect(await updateOrderTrackingAction(orderId, "ZZ", "123")).toEqual({
      success: false,
      error: "지원하지 않는 택배사입니다.",
    });
    expect(await updateOrderTrackingAction(orderId, "04", "   ")).toEqual({
      success: false,
      error: "운송장번호를 입력해주세요.",
    });
    expect((await orderRow(orderId)).tracking_number).toBeNull();
  });

  it("다른 공급사 사장은 남의 발주 운송장을 못 넣는다", async () => {
    const product = await world.createProduct();
    const orderId = await world.createOrder({ product, status: "confirmed" });

    await actAs(world.users.ownerB);
    const result = await updateOrderTrackingAction(orderId, "04", "123");

    expect(result.success).toBe(false);
    expect((await orderRow(orderId)).tracking_number).toBeNull();
  });
});

describe("getHistoricalOrdersAction", () => {
  it("내 공급사의 배송완료·취소 발주만 돌려주고 진행 중·타사 발주는 섞이지 않는다", async () => {
    const product = await world.createProduct();
    const delivered = await world.createOrder({ product, status: "delivered" });
    const cancelled = await world.createOrder({ product, status: "cancelled" });
    const active = await world.createOrder({ product, status: "pending" });

    const result = await getHistoricalOrdersAction(null, 0);

    expect(result.success).toBe(true);

    const ids = result.data!.entries.map((entry) => entry.id);

    expect(ids).toEqual(expect.arrayContaining([delivered, cancelled]));
    expect(ids).not.toContain(active);
    expect(result.data!.totalCount).toBeGreaterThanOrEqual(2);
  });

  it("다른 공급사 사장에겐 A사 발주가 한 건도 안 보인다", async () => {
    const product = await world.createProduct();
    const delivered = await world.createOrder({ product, status: "delivered" });

    await actAs(world.users.ownerB);
    const result = await getHistoricalOrdersAction(null, 0);

    expect(result.success).toBe(true);
    expect(result.data!.entries.map((entry) => entry.id)).not.toContain(delivered);
  });

  it("비로그인은 '로그인이 필요합니다'", async () => {
    await actAs(null);

    expect(await getHistoricalOrdersAction(null, 0)).toEqual({ success: false, error: "로그인이 필요합니다." });
  });
});
