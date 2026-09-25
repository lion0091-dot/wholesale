/**
 * 2. 상품 관리 — 서버 액션 한 겹(역할 게이트·폼 검증·정체성 잠금·낙관적 잠금·발주정지 페어·삭제/보관 안내) + 실제 DB.
 * DB 함수 레벨은 scripts/db-test-product-management.sql 등이 이미 한다. 외부 API 없음.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";
import { MANUAL_DEFAULT_DELIVERY_ITEMS } from "@/lib/products/default-delivery-items";
import { recordScanAction } from "@/app/dashboard/inbound/actions";
import {
  bulkUpdateProductPricesAction,
  createProductAction,
  deleteProductAction,
  getProductStockBreakdownAction,
  seedDefaultProductsAction,
  setProductArchivedAction,
  toggleProductFlagAction,
  updateProductAction,
  updateProductStockAction,
} from "@/app/dashboard/products/actions";

let world: World;

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  const defaults: Record<string, string> = {
    name: "테스트 소시지",
    category: "가공육",
    subcategory: "소시지",
    origin: "국내산",
    base_price: "15000",
    stock_quantity: "0",
  };

  for (const [key, value] of Object.entries({ ...defaults, ...fields })) {
    data.set(key, value);
  }

  return data;
}

async function row(productId: string) {
  const { data } = await adminClient().from("products").select("*").eq("id", productId).single();

  return data as Record<string, unknown>;
}

const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

beforeEach(async () => {
  await actAs(world.users.ownerA);
});

describe("상품 액션 — 권한·격리", () => {
  it("직원(staff)·고객·비로그인은 상품 액션을 쓸 수 없다(상품 관리는 owner/manager 전용)", async () => {
    const product = await world.createProduct();

    for (const user of [world.users.staffA, world.users.retailerR, null]) {
      await actAs(user);

      const results = [
        await createProductAction(form()),
        await updateProductAction(product.id, form()),
        await toggleProductFlagAction(product.id, "is_active", false),
        await updateProductStockAction(product.id, 3, "STOCKTAKE"),
        await deleteProductAction(product.id),
        await setProductArchivedAction(product.id, true),
        await bulkUpdateProductPricesAction([{ id: product.id, price: 1000 }], false),
        await getProductStockBreakdownAction(product.id),
      ];

      for (const result of results) {
        expect(result.success).toBe(false);
      }
    }

    const after = await row(product.id);

    expect(after.is_active).toBe(true);
    expect(after.archived_at).toBeNull();
    expect(Number(after.base_price)).toBe(15000);
  });

  it("매니저는 상품을 등록·수정할 수 있다", async () => {
    await actAs(world.users.managerA);

    const created = await createProductAction(form({ name: "매니저 등록 상품" }));

    expect(created.success).toBe(true);
    expect((await updateProductAction(created.data!.id, form({ name: "매니저 등록 상품", base_price: "16000" }))).success).toBe(true);
  });

  it("다른 공급사 사장은 남의 상품을 수정·토글·재고조정·삭제·보관·가격변경할 수 없다", async () => {
    const product = await world.createProduct();

    await actAs(world.users.ownerB);

    expect((await updateProductAction(product.id, form({ base_price: "1" }))).success).toBe(false);
    expect((await toggleProductFlagAction(product.id, "is_active", false)).success).toBe(false);
    expect((await updateProductStockAction(product.id, 999, "STOCKTAKE")).success).toBe(false);
    expect((await deleteProductAction(product.id)).success).toBe(false);
    expect((await setProductArchivedAction(product.id, true)).success).toBe(false);

    const bulk = await bulkUpdateProductPricesAction([{ id: product.id, price: 1 }], true);

    expect(bulk.data).toMatchObject({ updated: 0, notFound: 1 });

    const after = await row(product.id);

    expect(after).toMatchObject({ is_active: true, archived_at: null });
    expect(Number(after.base_price)).toBe(15000);
    expect(Number(after.stock_quantity)).toBe(5);
  });
});

describe("createProductAction", () => {
  it("정상 등록 — 콤마 가격을 파싱하고 소유 공급사는 서버가 정한다(폼에 끼워 보낸 wholesaler_id 무시)", async () => {
    const data = form({ name: "정상 등록 상품", base_price: "25,000", stock_quantity: "3", description: "  메모  " });

    data.set("wholesaler_id", world.wholesalerB);

    const result = await createProductAction(data);

    expect(result.success).toBe(true);

    const created = await row(result.data!.id);

    expect(created).toMatchObject({ wholesaler_id: world.wholesalerA, name: "정상 등록 상품", category: "가공육", origin: "국내산", description: "메모", is_active: true });
    expect(Number(created.base_price)).toBe(25000);
    expect(Number(created.stock_quantity)).toBe(3);
  });

  it("폼 검증 — 이름·카테고리·원산지·단가·재고·핫딜 입력 오류를 각각 안내문으로 거부하고 아무것도 저장하지 않는다", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ name: "가" }, "상품명을 2자 이상"],
      [{ category: "" }, "카테고리(부위 구분)를 선택"],
      [{ origin: "" }, "원산지를 입력"],
      [{ base_price: "-1" }, "기본 단가는 0 이상"],
      [{ base_price: "abc" }, "기본 단가는 0 이상"],
      [{ stock_quantity: "-3" }, "재고 수량은 0 이상"],
      [{ hot_deal_active: "on", hot_deal_price: "" }, "핫딜을 켜려면 할인가"],
      [{ hot_deal_active: "on", hot_deal_price: "10000", hot_deal_quantity_limit: "0" }, "핫딜 판매 한도는 0보다 큰"],
      [{ hot_deal_active: "on", hot_deal_price: "10000", hot_deal_quota_alert_threshold: "-1" }, "임박 알림 기준은 0 이상"],
    ];
    const marker = `검증실패-${world.runId}`;

    for (const [patch, message] of cases) {
      const result = await createProductAction(form({ ...patch, description: marker }));

      expect(result.success).toBe(false);
      expect(result.error).toContain(message);
    }

    const { count } = await adminClient().from("products").select("id", { count: "exact", head: true }).eq("description", marker);

    expect(count).toBe(0);
  });

  it("핫딜을 켜고 등록하면 핫딜 필드가 그대로 저장된다", async () => {
    const result = await createProductAction(
      form({ name: "핫딜 등록 상품", hot_deal_active: "on", hot_deal_price: "10,000", hot_deal_quantity_limit: "20", hot_deal_quota_alert_threshold: "3" })
    );

    expect(result.success).toBe(true);
    expect(await row(result.data!.id)).toMatchObject({ hot_deal_active: true, hot_deal_price: 10000, hot_deal_quantity_limit: 20, hot_deal_quota_alert_threshold: 3 });
  });

  it("이력 대상 축종(소·돼지·닭/오리)은 손으로 등록할 수 없고, 이력번호가 없는 양·가공육은 등록된다", async () => {
    const marker = `손등록차단-${world.runId}`;

    for (const category of ["소", "돼지", "닭/오리"]) {
      const result = await createProductAction(
        form({ category, subcategory: "등심", grade: "1++", origin: "국내산", name: "손 등록 시도", description: marker })
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("입고 스캔으로 자동 등록됩니다");
    }

    const { count } = await adminClient().from("products").select("id", { count: "exact", head: true }).eq("description", marker);

    expect(count).toBe(0);

    for (const category of ["양", "가공육"]) {
      const result = await createProductAction(form({ category, subcategory: "", name: `${category} 등록 상품`, description: marker }));

      expect(result.success).toBe(true);
    }
  });
});

describe("updateProductAction", () => {
  it("축종·상품명·원산지는 바꿔 보내도 안 바뀌고, 부위·등급·단가·판매여부만 갱신되며 재고 값은 무시된다", async () => {
    const product = await world.createProduct({ stock_quantity: 5 });
    const result = await updateProductAction(
      product.id,
      form({ name: "다른 이름", category: "소", origin: "수입산", subcategory: "안심", grade: "1+", base_price: "18,000", stock_quantity: "999", is_active: "off", description: "수정 메모" })
    );

    expect(result.success).toBe(true);

    const after = await row(product.id);

    expect(after).toMatchObject({ name: product.name, category: "돼지", origin: "국내산", subcategory: "안심", grade: "1+", is_active: false, description: "수정 메모" });
    expect(Number(after.base_price)).toBe(18000);
    expect(Number(after.stock_quantity)).toBe(5);
  });

  it("폼을 연 뒤 다른 곳에서 먼저 저장됐으면(updated_at 불일치) 충돌로 거부하고 덮어쓰지 않는다", async () => {
    const product = await world.createProduct();
    const stale = await updateProductAction(product.id, form({ base_price: "20000", updated_at: "2020-01-01T00:00:00+00:00" }));

    expect(stale.success).toBe(false);
    expect(stale.error).toContain("다른 곳에서 먼저 변경되었습니다");
    expect(Number((await row(product.id)).base_price)).toBe(15000);

    const fresh = await updateProductAction(product.id, form({ base_price: "20000", updated_at: String((await row(product.id)).updated_at) }));

    expect(fresh.success).toBe(true);
    expect(Number((await row(product.id)).base_price)).toBe(20000);
  });

  it("상품 ID 형식이 틀리거나 없는 상품이면 각각 안내문으로 거부한다", async () => {
    expect(await updateProductAction("bad-id", form())).toEqual({ success: false, error: "올바른 상품 식별자가 아닙니다." });

    const missing = await updateProductAction("00000000-0000-4000-8000-000000000000", form());

    expect(missing.success).toBe(false);
    expect(missing.error).toContain("상품을 찾을 수 없거나");
  });

  it("발주정지 — stop 은 수동 정지, resume 은 해제, none 은 건드리지 않는다", async () => {
    const product = await world.createProduct();

    expect((await updateProductAction(product.id, form({ order_stopped_action: "stop" }))).success).toBe(true);
    expect(await row(product.id)).toMatchObject({ order_stopped: true, order_stopped_reason: "manual" });

    expect((await updateProductAction(product.id, form({ order_stopped_action: "none", description: "다른 저장" }))).success).toBe(true);
    expect(await row(product.id)).toMatchObject({ order_stopped: true, order_stopped_reason: "manual" });

    expect((await updateProductAction(product.id, form({ order_stopped_action: "resume" }))).success).toBe(true);
    expect(await row(product.id)).toMatchObject({ order_stopped: false, order_stopped_reason: null });
  });

  it("핫딜을 끄면 발주정지가 함께 풀리지만, 재고가 0이면 유지하고, 원래 핫딜을 안 쓰던 상품의 수동 정지는 건드리지 않는다", async () => {
    const hotOff = await world.createProduct({ hot_deal_active: true, hot_deal_price: 10000, order_stopped: true, order_stopped_reason: "manual", order_stopped_at: new Date().toISOString() });
    const hotOffNoStock = await world.createProduct({ hot_deal_active: true, hot_deal_price: 10000, order_stopped: true, order_stopped_reason: "manual", order_stopped_at: new Date().toISOString() });
    const plain = await world.createProduct({ order_stopped: true, order_stopped_reason: "manual", order_stopped_at: new Date().toISOString() });

    expect((await updateProductAction(hotOff.id, form({ hot_deal_price: "10000", hot_deal_active_snapshot: "on", stock_quantity_snapshot: "5" }))).success).toBe(true);
    expect(await row(hotOff.id)).toMatchObject({ hot_deal_active: false, order_stopped: false });

    expect((await updateProductAction(hotOffNoStock.id, form({ hot_deal_price: "10000", hot_deal_active_snapshot: "on", stock_quantity_snapshot: "0" }))).success).toBe(true);
    expect(await row(hotOffNoStock.id)).toMatchObject({ hot_deal_active: false, order_stopped: true });

    expect((await updateProductAction(plain.id, form({ hot_deal_active_snapshot: "off", stock_quantity_snapshot: "5" }))).success).toBe(true);
    expect(await row(plain.id)).toMatchObject({ order_stopped: true, order_stopped_reason: "manual" });
  });
});

describe("toggleProductFlagAction", () => {
  it("판매 여부를 껐다 켤 수 있고, 허용되지 않은 항목·잘못된 ID는 거부한다", async () => {
    const product = await world.createProduct();

    expect((await toggleProductFlagAction(product.id, "is_active", false)).success).toBe(true);
    expect((await row(product.id)).is_active).toBe(false);
    expect((await toggleProductFlagAction(product.id, "is_active", true)).success).toBe(true);
    expect((await row(product.id)).is_active).toBe(true);

    expect(await toggleProductFlagAction(product.id, "base_price" as never, true)).toEqual({ success: false, error: "변경할 수 없는 항목입니다." });
    expect(await toggleProductFlagAction("bad", "is_active", true)).toEqual({ success: false, error: "올바른 상품 식별자가 아닙니다." });
  });
});

describe("updateProductStockAction — 재고 조정", () => {
  it("실사로 늘리고 폐기로 줄이면 재고가 반영되고 원장에 조정·손실 기록이 남는다", async () => {
    const product = await world.createProduct({ stock_quantity: 5 });

    expect((await updateProductStockAction(product.id, 8, "STOCKTAKE", "  분기 실사  ")).success).toBe(true);
    expect(Number((await row(product.id)).stock_quantity)).toBe(8);

    expect((await updateProductStockAction(product.id, 2, "DISPOSAL")).success).toBe(true);
    expect(Number((await row(product.id)).stock_quantity)).toBe(2);

    const { data: ledger } = await adminClient().from("stock_ledger").select("event_type, qty_delta, reason").eq("product_id", product.id).order("created_at");
    const types = (ledger ?? []).map((entry) => String(entry.event_type));

    expect(types).toEqual(expect.arrayContaining(["ADJUSTMENT", "LOSS"]));
    expect((ledger ?? []).find((entry) => entry.event_type === "LOSS")).toMatchObject({ qty_delta: -6 });
    expect((ledger ?? []).some((entry) => String(entry.reason).includes("분기 실사"))).toBe(true);
    expect((ledger ?? []).reduce((sum, entry) => sum + Number(entry.qty_delta), 0)).toBe(2);
  });

  it("사유가 없거나 목록 밖이면, 수량이 음수·숫자가 아니면 거부하고 재고를 안 바꾼다", async () => {
    const product = await world.createProduct({ stock_quantity: 5 });

    expect(await updateProductStockAction(product.id, 3, "BOGUS")).toEqual({ success: false, error: "조정 사유를 선택해주세요." });
    expect(await updateProductStockAction(product.id, -1, "STOCKTAKE")).toEqual({ success: false, error: "재고 수량은 0 이상의 숫자여야 합니다." });
    expect((await updateProductStockAction(product.id, Number.NaN, "STOCKTAKE")).success).toBe(false);
    expect((await updateProductStockAction("bad", 3, "STOCKTAKE")).success).toBe(false);
    expect(Number((await row(product.id)).stock_quantity)).toBe(5);
  });
});

describe("deleteProductAction · setProductArchivedAction", () => {
  it("기록 없는 상품은 삭제된다", async () => {
    const product = await world.createProduct();

    expect((await deleteProductAction(product.id)).success).toBe(true);
    expect((await adminClient().from("products").select("id").eq("id", product.id)).data).toEqual([]);
  });

  it("입출고 기록이 있는 상품은 삭제 대신 '보관' 안내가 나온다", async () => {
    const product = await world.createProduct({ stock_quantity: 5 });

    expect((await updateProductStockAction(product.id, 7, "STOCKTAKE")).success).toBe(true);

    const result = await deleteProductAction(product.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain("입출고 기록이 있는 상품은 삭제할 수 없습니다");
    expect(result.error).toContain("보관");
    expect((await row(product.id)).id).toBe(product.id);
  });

  it("재고 기록은 없지만 주문에 걸린 상품도 외래키 오류 문구 대신 같은 보관 안내가 나온다", async () => {
    const product = await world.createProduct();

    await world.createOrder({ product });

    const result = await deleteProductAction(product.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain("이 상품을 참조하는 기록이 있어 삭제할 수 없습니다");
    expect(result.error).not.toMatch(/violates|foreign key|constraint/i);
  });

  it("보관하면 판매가 내려가고 보관 시각이 남으며, 복원하면 보관만 풀리고 판매는 꺼진 채로 둔다", async () => {
    const product = await world.createProduct();

    expect((await setProductArchivedAction(product.id, true)).success).toBe(true);

    const archived = await row(product.id);

    expect(archived.is_active).toBe(false);
    expect(archived.archived_at).not.toBeNull();

    expect((await setProductArchivedAction(product.id, false)).success).toBe(true);

    const restored = await row(product.id);

    expect(restored.archived_at).toBeNull();
    expect(restored.is_active).toBe(false);
  });

  it("없는 상품·잘못된 ID는 각각 안내문으로 거부한다", async () => {
    expect(await setProductArchivedAction("bad", true)).toEqual({ success: false, error: "올바른 상품 식별자가 아닙니다." });
    expect(await setProductArchivedAction("00000000-0000-4000-8000-000000000000", true)).toEqual({ success: false, error: "권한이 없거나 해당 상품을 찾을 수 없습니다." });
    expect(await deleteProductAction("bad")).toEqual({ success: false, error: "올바른 상품 식별자가 아닙니다." });
  });
});

describe("seedDefaultProductsAction", () => {
  it("상품이 이미 있으면 거부하고, 상품이 없는 공급사에서만 기본 납품 품목을 만든다(한 번만)", async () => {
    await world.createProduct();
    expect(await seedDefaultProductsAction()).toEqual({
      success: false,
      error: "이미 등록된 상품이 있습니다. 기본 납품 품목은 상품이 없을 때만 불러올 수 있습니다.",
    });

    await adminClient().from("products").delete().eq("wholesaler_id", world.wholesalerB);
    await actAs(world.users.ownerB);

    const created = await seedDefaultProductsAction();

    expect(created).toEqual({ success: true, data: { created: MANUAL_DEFAULT_DELIVERY_ITEMS.length } });
    expect((await seedDefaultProductsAction()).success).toBe(false);
  });
});

describe("bulkUpdateProductPricesAction", () => {
  it("빈 목록과 5,000행 초과는 거부한다", async () => {
    expect(await bulkUpdateProductPricesAction([], false)).toEqual({ success: false, error: "반영할 판매가가 없습니다." });

    const tooMany = Array.from({ length: 5001 }, (_, index) => ({ id: `id-${index}`, price: 1000 }));

    expect(await bulkUpdateProductPricesAction(tooMany, false)).toEqual({ success: false, error: "한 번에 5,000행까지만 올릴 수 있습니다." });
  });

  it("가격을 반영하고, 값이 없는 줄은 건너뛰고, 내 상품이 아니거나 보관됐거나 ID가 깨진 줄은 못 찾음으로 센다(판매 켜기 옵션 포함)", async () => {
    const target = await world.createProduct({ is_active: false });
    const zeroPrice = await world.createProduct();
    const archived = await world.createProduct({ archived_at: new Date().toISOString(), is_active: false });
    const foreign = await world.createProduct({ wholesaler_id: world.wholesalerB });

    const result = await bulkUpdateProductPricesAction(
      [
        { id: target.id, price: 22000 },
        { id: zeroPrice.id, price: 0 },
        { id: archived.id, price: 5000 },
        { id: foreign.id, price: 5000 },
        { id: "not-a-uuid", price: 5000 },
      ],
      true
    );

    expect(result).toEqual({ success: true, data: { updated: 1, skipped: 1, notFound: 3 } });
    expect(await row(target.id)).toMatchObject({ is_active: true });
    expect(Number((await row(target.id)).base_price)).toBe(22000);
    expect(Number((await row(zeroPrice.id)).base_price)).toBe(15000);
    expect(Number((await row(archived.id)).base_price)).toBe(15000);
    expect(Number((await row(foreign.id)).base_price)).toBe(15000);
  });

  it("판매 켜기 옵션을 끄면 판매 여부는 그대로 두고 가격만 바꾼다", async () => {
    const product = await world.createProduct({ is_active: false });

    expect((await bulkUpdateProductPricesAction([{ id: product.id, price: 19000 }], false)).data).toMatchObject({ updated: 1 });
    expect(await row(product.id)).toMatchObject({ is_active: false });
    expect(Number((await row(product.id)).base_price)).toBe(19000);
  });
});

describe("getProductStockBreakdownAction", () => {
  async function intake(product: WorldProduct, weight: number, bestBefore: string | null) {
    const traceNo = world.newTraceNo();

    await world.seedTrace(traceNo);
    expect((await recordScanAction({ traceNo, weight, scanType: "BARCODE_SCAN", productId: product.id, bestBefore })).success).toBe(true);

    return traceNo;
  }

  it("입고 박스를 오래된 순으로 잔량·유통기한과 함께 돌려주고, 다른 공급사에는 아무것도 안 보인다", async () => {
    const product = await world.createProduct({ stock_quantity: 0, subcategory: "등심", category: "소" });
    const first = await intake(product, 5, null);
    const second = await intake(product, 3.5, isoDay(10));

    const result = await getProductStockBreakdownAction(product.id);

    expect(result.success).toBe(true);
    expect(result.data!.map((box) => box.traceNo)).toEqual([first, second]);
    expect(result.data!.map((box) => box.remainingWeight)).toEqual([5, 3.5]);
    expect(result.data![1].bestBefore).toBe(isoDay(10));

    await actAs(world.users.ownerB);
    expect(await getProductStockBreakdownAction(product.id)).toEqual({ success: true, data: [] });
    expect(await getProductStockBreakdownAction("bad")).toEqual({ success: false, error: "올바른 상품 식별자가 아닙니다." });
  });
});

describe("소 상품 정체성 키 = 축종 + 부위 + 등급 + 원산지 (수정 경로 — 소 상품은 스캔으로만 생기고 손 등록은 막힌다)", () => {
  const cattle = (fields: Record<string, string> = {}) =>
    form({ category: "소", subcategory: "등심", grade: "1++", origin: "국내산", name: "", ...fields });

  // 이 파일의 다른 테스트가 만든 소 상품과 겹치지 않도록 이 describe는 부위를 실행마다 고유하게 쓴다.
  const part = (label: string) => `${label}-${world.runId}`;
  const seedCattle = (subcategory: string | null, grade: string | null, origin = "국내산") =>
    world.createProduct({ category: "소", subcategory, grade, origin, name: subcategory ? `${subcategory} ${grade ?? ""}`.trim() : "(부위 미지정)" });

  it("등록 후 부위·등급·원산지·상품명을 바꿔 보내도 안 바뀌고 단가만 바뀐다", async () => {
    const p = part("등심F");
    const created = await seedCattle(p, "1++");
    const result = await updateProductAction(
      created.id,
      cattle({ subcategory: part("안심F"), grade: "1", origin: "미국산", name: "다른 이름", base_price: "33,000" })
    );

    expect(result.success).toBe(true);

    const after = await row(created.id);

    expect(after).toMatchObject({ name: `${p} 1++`, subcategory: p, grade: "1++", origin: "국내산" });
    expect(Number(after.base_price)).toBe(33000);
  });

  it("이력으로 자동 생성돼 부위·등급이 비어 있는 소 상품은 가격만 고칠 수 있고, 비어 있던 칸은 한 번 채울 수 있으며 이름이 다시 만들어진다", async () => {
    const p = part("등심G");
    const legacy = await seedCattle(null, null);

    // 부위·등급 없이 가격만 — 수정에서는 요구하지 않는다.
    const priceOnly = await updateProductAction(legacy.id, cattle({ subcategory: "", grade: "", base_price: "21,000" }));

    expect(priceOnly.success).toBe(true);
    expect(await row(legacy.id)).toMatchObject({ name: "(부위 미지정)", subcategory: null });

    const filled = await updateProductAction(legacy.id, cattle({ subcategory: p, grade: "1+" }));

    expect(filled.success).toBe(true);
    expect(await row(legacy.id)).toMatchObject({ name: `${p} 1+`, subcategory: p, grade: "1+" });

    // 채운 뒤에는 잠긴다
    expect((await updateProductAction(legacy.id, cattle({ subcategory: part("다른"), grade: "1" }))).success).toBe(true);
    expect(await row(legacy.id)).toMatchObject({ subcategory: p, grade: "1+" });
  });

  it("비어 있던 칸을 채웠더니 이미 있는 상품과 키가 같아지면 거부하고 아무것도 바꾸지 않는다", async () => {
    const p = part("등심H");

    await seedCattle(p, "1++");

    const legacy = await seedCattle(null, null);
    const clash = await updateProductAction(legacy.id, cattle({ subcategory: p, grade: "1++" }));

    expect(clash.success).toBe(false);
    expect(clash.error).toContain("이미 같은 상품이 등록되어 있습니다");
    expect(await row(legacy.id)).toMatchObject({ name: "(부위 미지정)", subcategory: null, grade: null });

    // 부위·등급이 빈 소 상품은 공급사당 하나만 둘 수 있다(마이그레이션 121) — 다음 테스트가 새로 만들 수 있게 치운다.
    await adminClient().from("products").delete().eq("id", legacy.id);
  });

  it("보관된 같은 상품이 있으면 새로 만들지 말고 복원하라고 안내한다", async () => {
    const p = part("등심D");
    const archived = await seedCattle(p, "1++");

    expect((await setProductArchivedAction(archived.id, true)).success).toBe(true);

    const legacy = await seedCattle(null, null);
    const clash = await updateProductAction(legacy.id, cattle({ subcategory: p, grade: "1++" }));

    expect(clash.success).toBe(false);
    expect(clash.error).toContain("보관된 같은 상품이 있습니다");
  });
});
