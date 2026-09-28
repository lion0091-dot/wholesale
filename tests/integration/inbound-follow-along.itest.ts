/**
 * 따라가기 테스트 — 입고 스캔 화면이 실제로 쓰는 조회(loadInboundData)로 하루를 끝까지 걸으며,
 * 카드가 다음 할 일을 제대로 말하는지, 카드가 가리키는 자리가 화면에 실제로 있는지 본다.
 * 업무를 몰라도 카드만 따라가면 끊기지 않는 것이 기준이다(docs/verification-rules.md "따라가기 끊김 점검").
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World } from "./harness";
import { resolveMappingAction } from "@/app/dashboard/inbound/actions";
import { loadInboundData } from "@/app/dashboard/inbound/inbound-data";
import { INBOUND_ANCHORS, pickFieldNextStep } from "@/lib/livestock/inbound-next-step";
import type { SupplierScope } from "@/lib/supplier/scope";

let world: World;
let scope: SupplierScope;

beforeAll(async () => {
  world = await seedWorld();
  scope = {
    userId: world.users.ownerA.id,
    organizationId: null,
    orgRole: "owner",
    platformRole: null,
    isSuperAdmin: false,
    wholesalerId: world.wholesalerA,
    businessName: "테스트",
    shopToken: null,
  };
});

afterAll(async () => {
  await world?.cleanup();
});

/** 화면이 그리는 현장(입고 스캔) 카드. */
async function cards() {
  await actAs(world.users.ownerA);

  const data = await loadInboundData(scope);

  return { data, field: pickFieldNextStep(data.nextStepInput) };
}

function newProduct() {
  return world.createProduct({ stock_quantity: 0, category: "소", subcategory: "등심" });
}

describe("따라가기 2 — 확인이 필요한 박스는 최근 100건 밖으로 밀려나도 화면과 카드에서 찾을 수 있다", () => {
  it("배지가 세는 박스는 입고 화면 목록에도 있고, 카드 링크(#scan-…)가 그 행을 가리키며, 상품을 지정하면 사라진다", async () => {
    const product = await newProduct();
    const stuckTrace = world.newTraceNo();

    // 이력을 못 찾은 박스(확인 필요) 하나 — 그 뒤로 정상 박스가 105개 더 찍혔다.
    const { data: stuck } = await adminClient()
      .from("inbound_scans")
      .insert({
        wholesaler_id: world.wholesalerA,
        trace_no: stuckTrace,
        weight: 5,
        unit: "kg",
        scan_type: "BARCODE_SCAN",
        status: "EXCEPTION",
        remaining_weight: 0,
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
      })
      .select("id")
      .single();
    const stuckId = String(stuck?.id);

    const later = Array.from({ length: 105 }, (_, index) => ({
      wholesaler_id: world.wholesalerA,
      trace_no: world.newTraceNo(),
      product_id: product.id,
      weight: 1,
      unit: "kg",
      scan_type: "BARCODE_SCAN",
      status: "NORMAL",
      remaining_weight: 1,
      created_at: new Date(Date.now() - 600_000 + index * 1000).toISOString(),
    }));

    for (let i = 0; i < later.length; i += 50) {
      const { error } = await adminClient().from("inbound_scans").insert(later.slice(i, i + 50));

      expect(error).toBeNull();
    }

    const step = await cards();

    expect(step.data.nextStepInput.needsCheckScanCount).toBeGreaterThanOrEqual(1);
    expect(step.data.scans.map((row) => row.id)).toContain(stuckId);

    // "지금 할 일"은 그 박스 처리 하나이고, 버튼이 화면 목록에 실제로 있는 그 박스 행으로 간다.
    expect(step.field.key).toBe("field-check");
    expect(step.field.href).toBe(`#scan-${stuckId}`);

    // 상품을 지정하면 재고에 들어가고 확인 필요가 사라진다.
    expect((await resolveMappingAction(stuckId, product.id, false)).success).toBe(true);
    expect((await cards()).data.nextStepInput.needsCheckScanCount).toBe(0);
  });
});

describe("따라가기 3 — 카드 버튼이 가리키는 자리는 화면에 실제로 그려진다", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);

      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".tsx") ? [path] : [];
    });
  }

  it("INBOUND_ANCHORS의 모든 자리가 어느 화면에선가 id로 존재한다(없으면 버튼을 눌러도 아무 데도 안 간다)", () => {
    const sources = sourceFiles(join(process.cwd(), "app", "dashboard")).map((path) => readFileSync(path, "utf8"));

    for (const [name, anchor] of Object.entries(INBOUND_ANCHORS)) {
      const id = anchor.slice(1);
      const found = sources.some((text) => text.includes(`id="${id}"`));

      expect(found, `${name} → id="${id}"`).toBe(true);
    }
  });
});

describe("따라가기 4 — 상품 지정 목록에는 판매중지 상품(입고 때 자동으로 만든 상품)도 나온다", () => {
  it("판매중지 상품은 목록에 있고, 보관한(감춘) 상품만 빠진다", async () => {
    const inactive = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "판매중지부위", is_active: false });
    const archived = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "보관부위", archived_at: new Date().toISOString() });
    const active = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "판매중부위", is_active: true });

    await actAs(world.users.ownerA);

    const ids = (await loadInboundData(scope)).products.map((product) => product.id);

    expect(ids).toContain(inactive.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(archived.id);
  });

  it("판매중지 상품으로도 확인 필요 박스를 지정하면 재고에 들어간다(입고에는 판매 여부가 필요 없다)", async () => {
    const inactive = await world.createProduct({ stock_quantity: 0, category: "소", subcategory: "판매중지부위2", is_active: false });
    const trace = world.newTraceNo();
    const { data: box } = await adminClient()
      .from("inbound_scans")
      .insert({ wholesaler_id: world.wholesalerA, trace_no: trace, weight: 5, unit: "kg", scan_type: "BARCODE_SCAN", status: "PENDING_MAPPING", remaining_weight: 0 })
      .select("id")
      .single();

    expect((await resolveMappingAction(String(box?.id), inactive.id, false)).success).toBe(true);

    const { data } = await adminClient().from("products").select("stock_quantity").eq("id", inactive.id).single();

    expect(Number(data?.stock_quantity)).toBeCloseTo(5);
  });
});

describe("따라가기 5 — 상품이 없는 이유가 '보관'이면 화면 데이터가 그 수를 알려 준다", () => {
  it("보관된 상품만 있는 업체는 목록이 비고 보관 상품 수가 함께 온다", async () => {
    await adminClient().from("products").update({ archived_at: new Date().toISOString() }).eq("wholesaler_id", world.wholesalerA).is("archived_at", null);
    await actAs(world.users.ownerA);

    const data = await loadInboundData(scope);

    expect(data.products).toHaveLength(0);
    expect(data.archivedProductCount).toBeGreaterThan(0);
  });
});
