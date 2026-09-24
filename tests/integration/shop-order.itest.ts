/**
 * 5. 바이어 주문 생성 — 서버 액션 한 겹(신원 게이트·서버 재계산·검증·핫딜·외상·취소 요청·내역 격리) + 실제 DB.
 * PG 결제창(initiatePgPaymentAction)은 토스 계정이 없어 범위 밖. 알림톡 발송 모듈만 흉내 낸다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";

vi.mock("@/lib/notifications/alimtalk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/notifications/alimtalk")>();
  const sent = () =>
    vi.fn(async () => ({ success: true, status: "sent", messageId: "msg-test", sentAt: "", templateTitle: "", formattedMessage: "" }));

  return {
    ...original,
    sendOrderNotificationToWholesaler: sent(),
    sendCancelRequestNotificationToWholesaler: sent(),
    sendCreditLimitExceededNotificationToWholesaler: sent(),
    sendCreditLimitExceededNotificationToRetailer: sent(),
  };
});

import {
  sendCancelRequestNotificationToWholesaler,
  sendCreditLimitExceededNotificationToRetailer,
  sendCreditLimitExceededNotificationToWholesaler,
  sendOrderNotificationToWholesaler,
} from "@/lib/notifications/alimtalk";
import {
  loadShopOrderHistoryPageAction,
  requestOrderCancelAction,
  submitOrderAction,
  type SubmitOrderInput,
} from "@/app/shop/[shop_token]/actions";

const orderNotify = vi.mocked(sendOrderNotificationToWholesaler);
const cancelNotify = vi.mocked(sendCancelRequestNotificationToWholesaler);
const creditNotifyWholesaler = vi.mocked(sendCreditLimitExceededNotificationToWholesaler);
const creditNotifyRetailer = vi.mocked(sendCreditLimitExceededNotificationToRetailer);

let world: World;

function newProduct(overrides: Record<string, unknown> = {}): Promise<WorldProduct> {
  return world.createProduct({ stock_quantity: 5, base_price: 15000, ...overrides });
}

function submit(overrides: Partial<SubmitOrderInput> & { items: SubmitOrderInput["items"] }) {
  return submitOrderAction({
    shopToken: world.shopTokenA,
    restaurantName: "테스트식당",
    contactPhone: "01012345678",
    deliveryAddress: "서울시 테스트구 1번지",
    ...overrides,
  });
}

async function ordersOf(retailerId: string) {
  const { data } = await adminClient()
    .from("orders")
    .select("id, order_number, total_amount, status, payment_method")
    .eq("retailer_id", retailerId)
    .order("ordered_at", { ascending: true });

  return data ?? [];
}

async function itemsOf(orderId: string) {
  const { data } = await adminClient()
    .from("order_items")
    .select("product_id, unit_price, quantity, subtotal_amount, is_hot_deal")
    .eq("order_id", orderId);

  return (data ?? []).map((row) => ({
    productId: String(row.product_id),
    unitPrice: Number(row.unit_price),
    quantity: Number(row.quantity),
    subtotal: Number(row.subtotal_amount),
    isHotDeal: Boolean(row.is_hot_deal),
  }));
}

async function productRow(productId: string) {
  const { data } = await adminClient().from("products").select("stock_quantity, hot_deal_quantity_sold").eq("id", productId).single();

  return { stock: Number(data?.stock_quantity), hotSold: Number(data?.hot_deal_quantity_sold) };
}

async function relationOf(relationshipId: string) {
  const { data } = await adminClient().from("wholesaler_retailers").select("outstanding_balance").eq("id", relationshipId).single();

  return Number(data?.outstanding_balance);
}

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await actAs(world.users.retailerR);
});

describe("submitOrderAction — 신원·링크 게이트", () => {
  it("비로그인(세션 만료)은 로그인 안내와 함께 requiresAuth 로 돌려보낸다(카탈로그 조회보다 먼저 확인)", async () => {
    // 예전엔 카탈로그 조회가 먼저라 wholesalers RLS 때문에 notFound → "링크가 유효하지 않다"로 잘못 안내되고
    // requiresAuth 도 안 켜졌다(2026-09-24 통합테스트에서 발견해 수정).
    const product = await newProduct();

    await actAs(null);
    const result = await submit({ items: [{ productId: product.id, quantity: 4 }] });

    expect(result.success).toBe(false);
    expect(result.requiresAuth).toBe(true);
    expect(result.error).toContain("카카오 로그인이 필요합니다");
    expect(orderNotify).not.toHaveBeenCalled();
  });

  it("공급사·관리자 계정은 발주할 수 없다", async () => {
    const product = await newProduct();

    await actAs(world.users.ownerA);
    const result = await submit({ items: [{ productId: product.id, quantity: 4 }] });

    expect(result.success).toBe(false);
    expect(result.error).toContain("공급사/관리자 계정으로는 발주할 수 없습니다");
    expect(orderNotify).not.toHaveBeenCalled();
  });

  it("거래중지된 고객은 발주할 수 없고 주문이 남지 않는다", async () => {
    const product = await newProduct();
    const blocked = await world.createRetailer({ status: "blocked" });

    await actAs(blocked.user);
    const result = await submit({ items: [{ productId: product.id, quantity: 4 }] });

    expect(result.success).toBe(false);
    expect(await ordersOf(blocked.retailerId)).toHaveLength(0);
    expect(orderNotify).not.toHaveBeenCalled();
  });

  it("형식이 틀린 미니샵 주소와 존재하지 않는 미니샵 링크는 각각 알아볼 수 있는 안내문이 나온다(내부 digest 미노출)", async () => {
    const product = await newProduct();
    const items = [{ productId: product.id, quantity: 4 }];

    const malformed = await submit({ shopToken: "not-a-token", items });
    const missing = await submit({ shopToken: "00000000-0000-4000-8000-000000000000", items });

    expect(malformed.error).toContain("올바른 미니샵 주소가 아닙니다");
    expect(missing.error).toContain("이 미니샵 링크가 더 이상 유효하지 않습니다");
    expect(missing.error).not.toContain("NEXT_");
  });

  it("고객이 거래관계가 없는 다른 공급사(B)의 미니샵으로는 발주할 수 없다", async () => {
    const product = await newProduct();
    const result = await submit({ shopToken: world.shopTokenB, items: [{ productId: product.id, quantity: 4 }] });

    expect(result.success).toBe(false);
    expect(await ordersOf(world.retailerR)).toHaveLength(0);
  });
});

describe("submitOrderAction — 입력 검증", () => {
  it("상호·연락처·주소가 비면 거부한다", async () => {
    const product = await newProduct();
    const items = [{ productId: product.id, quantity: 4 }];

    for (const patch of [{ restaurantName: "  " }, { contactPhone: "" }, { deliveryAddress: "" }]) {
      const result = await submit({ items, ...patch });

      expect(result).toEqual({ success: false, error: "사업장(상호)명, 담당자 연락처, 배송지 주소는 필수 입력 사항입니다." });
    }
  });

  it("PG 결제는 이 경로로 접수되지 않는다", async () => {
    const product = await newProduct();
    const result = await submit({ items: [{ productId: product.id, quantity: 4 }], paymentMethod: "pg" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("PG 결제는 이 경로로 접수되지 않습니다");
    expect(await ordersOf(world.retailerR)).not.toContainEqual(expect.objectContaining({ payment_method: "pg" }));
  });
});

describe("submitOrderAction — 정상 주문과 서버 재계산", () => {
  it("기준가로 주문이 생성되고 총액·품목·알림톡이 맞으며, 접수대기 주문은 재고를 줄이지 않는다", async () => {
    const product = await newProduct();
    const result = await submit({ items: [{ productId: product.id, quantity: 4 }], deliveryNotes: "  문 앞에  " });

    expect(result.success).toBe(true);
    expect(result.orderNumber).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);
    expect(result.totalAmount).toBe(60000);
    expect(result.itemsSummary).toContain(product.name);
    expect(result.itemsSummary).toContain("4kg");
    expect(result.notificationId).toBe("msg-test");

    const [order] = (await ordersOf(world.retailerR)).filter((row) => row.order_number === result.orderNumber);

    expect(order).toMatchObject({ total_amount: 60000, status: "pending", payment_method: "prepaid" });
    expect(await itemsOf(String(order.id))).toEqual([{ productId: product.id, unitPrice: 15000, quantity: 4, subtotal: 60000, isHotDeal: false }]);
    expect((await productRow(product.id)).stock).toBe(5);

    expect(orderNotify).toHaveBeenCalledTimes(1);
    expect(orderNotify.mock.calls[0][0]).toMatchObject({
      wholesalerId: world.wholesalerA,
      orderNumber: result.orderNumber,
      totalAmount: 60000,
      deliveryNotes: "문 앞에",
    });
  });

  it("클라이언트가 끼워 보낸 단가·금액은 무시하고 서버 카탈로그 가격으로 계산한다", async () => {
    const product = await newProduct();
    const tampered = { productId: product.id, quantity: 4, unitPrice: 1, totalAmount: 4, requestedUnitPrice: 1 } as never;
    const result = await submit({ items: [tampered] });

    expect(result.success).toBe(true);
    expect(result.totalAmount).toBe(60000);

    const [order] = (await ordersOf(world.retailerR)).filter((row) => row.order_number === result.orderNumber);

    expect((await itemsOf(String(order.id)))[0]).toMatchObject({ unitPrice: 15000, subtotal: 60000 });
  });

  it("그 고객의 맞춤단가가 켜져 있으면 그 가격이 적용되고 다른 고객은 기준가를 낸다", async () => {
    const product = await newProduct();
    const other = await world.createRetailer();

    await adminClient().from("custom_prices").insert({
      wholesaler_id: world.wholesalerA,
      retailer_id: world.retailerR,
      product_id: product.id,
      custom_price: 12000,
      is_active: true,
    });

    const mine = await submit({ items: [{ productId: product.id, quantity: 5 }] });

    expect(mine.totalAmount).toBe(60000);

    const [mineOrder] = (await ordersOf(world.retailerR)).filter((row) => row.order_number === mine.orderNumber);

    expect((await itemsOf(String(mineOrder.id)))[0].unitPrice).toBe(12000);

    await actAs(other.user);
    const theirs = await submit({ items: [{ productId: product.id, quantity: 5 }] });

    expect(theirs.totalAmount).toBe(75000);
  });

  it("최초 주문 때 카카오 자리표시자 프로필(상호·주소·연락처)을 채우고, 이미 정보가 있는 고객은 덮어쓰지 않는다", async () => {
    const product = await newProduct({ stock_quantity: 50 });
    const placeholder = await world.createRetailer({ restaurantName: "카카오 회원", deliveryAddress: "", phone: "" });

    await actAs(placeholder.user);
    expect((await submit({ items: [{ productId: product.id, quantity: 4 }], restaurantName: "새 상호", deliveryAddress: "새 주소 1", contactPhone: "01099998888" })).success).toBe(true);

    const { data: retailer } = await adminClient().from("retailers").select("restaurant_name, delivery_address").eq("id", placeholder.retailerId).single();
    const { data: profile } = await adminClient().from("profiles").select("phone").eq("id", placeholder.user.id).single();

    expect(retailer).toEqual({ restaurant_name: "새 상호", delivery_address: "새 주소 1" });
    expect(profile?.phone).toBe("01099998888");

    const filled = await world.createRetailer({ restaurantName: "기존 상호", deliveryAddress: "기존 주소", phone: "01011110000" });

    await actAs(filled.user);
    expect((await submit({ items: [{ productId: product.id, quantity: 4 }], restaurantName: "바뀐 상호", deliveryAddress: "바뀐 주소", contactPhone: "01055556666" })).success).toBe(true);

    const { data: kept } = await adminClient().from("retailers").select("restaurant_name, delivery_address").eq("id", filled.retailerId).single();
    const { data: keptProfile } = await adminClient().from("profiles").select("phone").eq("id", filled.user.id).single();

    expect(kept).toEqual({ restaurant_name: "기존 상호", delivery_address: "기존 주소" });
    expect(keptProfile?.phone).toBe("01011110000");
  });
});

describe("submitOrderAction — 카탈로그·수량 규칙", () => {
  it("최소주문금액(50,000원) 미달이면 거부하고 주문·알림톡이 없다", async () => {
    const product = await newProduct();
    const before = (await ordersOf(world.retailerR)).length;
    const result = await submit({ items: [{ productId: product.id, quantity: 1 }] });

    expect(result.success).toBe(false);
    expect(result.error).toContain("50,000");
    expect((await ordersOf(world.retailerR)).length).toBe(before);
    expect(orderNotify).not.toHaveBeenCalled();
  });

  it("재고보다 많이 담으면 오류가 아니라 재고 수량으로 조용히 줄여서 접수한다(카탈로그 규칙)", async () => {
    const product = await newProduct({ stock_quantity: 5 });
    const result = await submit({ items: [{ productId: product.id, quantity: 100 }] });

    expect(result.success).toBe(true);
    expect(result.totalAmount).toBe(75000);

    const [order] = (await ordersOf(world.retailerR)).filter((row) => row.order_number === result.orderNumber);

    expect((await itemsOf(String(order.id)))[0].quantity).toBe(5);
  });

  it("발주정지·품절·타사·없는 상품은 카탈로그에서 빠져 담을 수 없다(전부 빠지면 빈 장바구니 안내)", async () => {
    const stopped = await newProduct({ order_stopped: true, order_stopped_reason: "manual" });
    const soldOut = await newProduct({ stock_quantity: 0 });
    const { data: foreign } = await adminClient()
      .from("products")
      .insert({ wholesaler_id: world.wholesalerB, name: `B사상품-${world.runId}`, category: "돼지", subcategory: "목살", origin: "국내산", base_price: 15000, unit: "kg", stock_quantity: 50, is_active: true })
      .select("id")
      .single();

    const result = await submit({
      items: [
        { productId: stopped.id, quantity: 4 },
        { productId: soldOut.id, quantity: 4 },
        { productId: String(foreign!.id), quantity: 4 },
        { productId: "00000000-0000-4000-8000-000000000000", quantity: 4 },
      ],
    });

    expect(result).toEqual({ success: false, error: "장바구니에 담긴 품목이 없습니다." });
  });

  it("담을 수 없는 상품이 섞여 있으면 그 상품만 빼고 나머지로 접수한다", async () => {
    const good = await newProduct();
    const stopped = await newProduct({ order_stopped: true, order_stopped_reason: "manual" });
    const result = await submit({
      items: [
        { productId: good.id, quantity: 4 },
        { productId: stopped.id, quantity: 4 },
      ],
    });

    expect(result.success).toBe(true);

    const [order] = (await ordersOf(world.retailerR)).filter((row) => row.order_number === result.orderNumber);

    expect((await itemsOf(String(order.id))).map((item) => item.productId)).toEqual([good.id]);
  });
});

describe("submitOrderAction — 핫딜", () => {
  it("핫딜가로 접수되고 판매량이 소진되며 품목에 핫딜 표시가 남는다", async () => {
    const product = await newProduct({ hot_deal_active: true, hot_deal_price: 10000, hot_deal_quantity_limit: 10, hot_deal_quantity_sold: 0 });
    const result = await submit({ items: [{ productId: product.id, quantity: 5 }] });

    expect(result.success).toBe(true);
    expect(result.totalAmount).toBe(50000);

    const [order] = (await ordersOf(world.retailerR)).filter((row) => row.order_number === result.orderNumber);

    expect((await itemsOf(String(order.id)))[0]).toMatchObject({ unitPrice: 10000, isHotDeal: true });
    expect((await productRow(product.id)).hotSold).toBe(5);
  });

  it("남은 한도보다 많이 담으면 한도까지만 접수한다", async () => {
    const product = await newProduct({ hot_deal_active: true, hot_deal_price: 30000, hot_deal_quantity_limit: 10, hot_deal_quantity_sold: 8, stock_quantity: 50 });
    const result = await submit({ items: [{ productId: product.id, quantity: 5 }] });

    expect(result.success).toBe(true);
    expect(result.totalAmount).toBe(60000);
    expect((await productRow(product.id)).hotSold).toBe(10);
  });

  it("남은 한도 2개를 두 요청이 동시에 채우려 하면 하나만 접수되고 진 쪽은 매진 안내를 받으며 유령 주문·초과 소진이 없다", async () => {
    const product = await newProduct({ hot_deal_active: true, hot_deal_price: 30000, hot_deal_quantity_limit: 10, hot_deal_quantity_sold: 8, stock_quantity: 50 });
    const before = (await ordersOf(world.retailerR)).length;

    const [a, b] = await Promise.all([
      submit({ items: [{ productId: product.id, quantity: 2 }] }),
      submit({ items: [{ productId: product.id, quantity: 2 }] }),
    ]);

    const results = [a, b];
    const wins = results.filter((result) => result.success);
    const losses = results.filter((result) => !result.success);

    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].error).toContain("핫딜 매진");
    expect((await productRow(product.id)).hotSold).toBe(10);
    expect((await ordersOf(world.retailerR)).length).toBe(before + 1);
  });
});

describe("submitOrderAction — 외상", () => {
  it("외상 한도가 0인 거래처는 외상 주문이 거부된다", async () => {
    const product = await newProduct();
    const noCredit = await world.createRetailer({ creditLimit: 0, allowedPaymentMethods: ["prepaid", "on_credit"] });

    await actAs(noCredit.user);
    const result = await submit({ items: [{ productId: product.id, quantity: 4 }], paymentMethod: "on_credit" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("외상 거래가 허용되지 않았습니다");
    expect(await ordersOf(noCredit.retailerId)).toHaveLength(0);
  });

  it("한도 안의 외상 주문은 접수되고 미수금이 주문 금액만큼 늘어난다", async () => {
    const product = await newProduct();
    const buyer = await world.createRetailer({ creditLimit: 100000, outstanding: 10000, allowedPaymentMethods: ["prepaid", "on_credit"] });

    await actAs(buyer.user);
    const result = await submit({ items: [{ productId: product.id, quantity: 4 }], paymentMethod: "on_credit" });

    expect(result.success).toBe(true);
    expect((await ordersOf(buyer.retailerId))[0]).toMatchObject({ payment_method: "on_credit", total_amount: 60000 });
    expect(await relationOf(buyer.relationshipId)).toBe(70000);
  });

  it("한도를 넘는 외상 주문은 미리 거부되고 주문·미수금 변화 없이 공급사·고객에게 알림이 간다", async () => {
    const product = await newProduct();
    const buyer = await world.createRetailer({ creditLimit: 100000, outstanding: 80000, allowedPaymentMethods: ["prepaid", "on_credit"] });

    await actAs(buyer.user);
    const result = await submit({ items: [{ productId: product.id, quantity: 4 }], paymentMethod: "on_credit" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("여신 한도를 초과하여 발주할 수 없습니다");
    expect(await ordersOf(buyer.retailerId)).toHaveLength(0);
    expect(await relationOf(buyer.relationshipId)).toBe(80000);
    expect(orderNotify).not.toHaveBeenCalled();
    expect(creditNotifyWholesaler).toHaveBeenCalledTimes(1);
    expect(creditNotifyRetailer).toHaveBeenCalledTimes(1);
  });

  it("한도 60,000원 남았을 때 60,000원 주문 2건이 동시에 들어오면 하나만 접수되고 미수금이 한도를 넘지 않는다", async () => {
    const product = await newProduct({ stock_quantity: 50 });
    const buyer = await world.createRetailer({ creditLimit: 100000, outstanding: 0, allowedPaymentMethods: ["prepaid", "on_credit"] });

    await actAs(buyer.user);
    const results = await Promise.all([
      submit({ items: [{ productId: product.id, quantity: 4 }], paymentMethod: "on_credit" }),
      submit({ items: [{ productId: product.id, quantity: 4 }], paymentMethod: "on_credit" }),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.find((result) => !result.success)?.error).toContain("여신 한도");
    expect(await ordersOf(buyer.retailerId)).toHaveLength(1);
    expect(await relationOf(buyer.relationshipId)).toBe(60000);
  });
});

describe("requestOrderCancelAction", () => {
  const reason = "주문을 잘못 넣어서 취소하고 싶습니다";

  it("사유가 비었거나 너무 짧으면 거부한다", async () => {
    const product = await newProduct();
    const orderId = await world.createOrder({ product });

    for (const bad of ["", "   ", "ㅇ"]) {
      const result = await requestOrderCancelAction({ shopToken: world.shopTokenA, orderId, reason: bad });

      expect(result.success).toBe(false);
      expect(result.error).toContain("취소 사유");
    }

    expect((await ordersOf(world.retailerR)).find((row) => row.id === orderId)?.status).toBe("pending");
  });

  it("주소·주문 ID 형식이 틀리면 거부한다", async () => {
    const product = await newProduct();
    const orderId = await world.createOrder({ product });

    expect((await requestOrderCancelAction({ shopToken: "bad", orderId, reason })).error).toContain("올바른 미니샵 주소가 아닙니다");
    expect((await requestOrderCancelAction({ shopToken: world.shopTokenA, orderId: "bad", reason })).error).toContain("올바른 발주서 식별자가 아닙니다");
  });

  it("비로그인은 로그인 안내(requiresAuth)가 나온다", async () => {
    const product = await newProduct();
    const orderId = await world.createOrder({ product });

    await actAs(null);
    const result = await requestOrderCancelAction({ shopToken: world.shopTokenA, orderId, reason });

    expect(result.success).toBe(false);
    expect(result.requiresAuth).toBe(true);
  });

  it("접수대기·확정 주문은 취소 요청이 접수되고 사유·시각이 저장되며 공급사에 알림톡이 간다", async () => {
    const product = await newProduct();

    for (const status of ["pending", "confirmed"]) {
      cancelNotify.mockClear();
      const orderId = await world.createOrder({ product, status });
      const result = await requestOrderCancelAction({ shopToken: world.shopTokenA, orderId, reason: `  ${reason}  ` });

      expect(result.success).toBe(true);
      expect(result.status).toBe("cancel_requested");
      expect(result.requestedAt).toBeTruthy();

      const { data } = await adminClient().from("orders").select("status, cancel_reason, cancel_requested_at").eq("id", orderId).single();

      expect(data).toMatchObject({ status: "cancel_requested", cancel_reason: reason });
      expect(data?.cancel_requested_at).toBeTruthy();
      expect(cancelNotify).toHaveBeenCalledTimes(1);
    }
  });

  it("이미 요청됐거나 출고가 진행된 주문은 각각 안내문으로 거절한다", async () => {
    const product = await newProduct();
    const requested = await world.createOrder({ product, status: "cancel_requested" });
    const shipping = await world.createOrder({ product, status: "shipping" });
    const delivered = await world.createOrder({ product, status: "delivered" });

    expect((await requestOrderCancelAction({ shopToken: world.shopTokenA, orderId: requested, reason })).error).toContain("이미 취소 요청이 접수된");

    for (const orderId of [shipping, delivered]) {
      const result = await requestOrderCancelAction({ shopToken: world.shopTokenA, orderId, reason });

      expect(result.success).toBe(false);
      expect(result.error).toContain("이미 출고가 진행된 발주서");
    }

    expect(cancelNotify).not.toHaveBeenCalled();
  });

  it("다른 고객의 주문은 '찾을 수 없다'로 거절되고 상태는 그대로다", async () => {
    const product = await newProduct();
    const other = await world.createRetailer();
    const theirs = await world.createOrder({ product });

    await adminClient().from("orders").update({ retailer_id: other.retailerId }).eq("id", theirs);

    const result = await requestOrderCancelAction({ shopToken: world.shopTokenA, orderId: theirs, reason });

    expect(result).toEqual({ success: false, error: "해당 발주서를 찾을 수 없습니다." });
    expect((await ordersOf(other.retailerId))[0].status).toBe("pending");
    expect(cancelNotify).not.toHaveBeenCalled();
  });
});

describe("loadShopOrderHistoryPageAction", () => {
  it("본인 주문만 돌려주고 다른 고객의 주문은 섞이지 않는다", async () => {
    const product = await newProduct();
    const mine = await world.createOrder({ product });
    const other = await world.createRetailer();
    const theirs = await world.createOrder({ product });

    await adminClient().from("orders").update({ retailer_id: other.retailerId }).eq("id", theirs);

    const result = await loadShopOrderHistoryPageAction(world.shopTokenA, null, 0);

    expect(result.success).toBe(true);

    const ids = result.data!.orders.map((order) => order.id);

    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect(result.data!.totalCount).toBe(ids.length);
  });

  it("비로그인은 로그인 안내가, 형식이 틀린 주소는 안내문이 나온다", async () => {
    await actAs(null);

    const anonymous = await loadShopOrderHistoryPageAction(world.shopTokenA, null, 0);

    expect(anonymous.success).toBe(false);
    expect(anonymous.error).toContain("카카오 로그인이 필요합니다");
    expect(await loadShopOrderHistoryPageAction("bad", null, 0)).toEqual({ success: false, error: "올바른 미니샵 주소가 아닙니다." });
  });
});
