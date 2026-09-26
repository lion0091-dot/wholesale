/**
 * 따라가기 테스트 — 입고 스캔 화면이 실제로 쓰는 조회(loadInboundData)로 하루를 끝까지 걸으며,
 * 단계마다 현장 카드·사무실 카드가 다음 할 일을 제대로 말하는지, 카드가 가리키는 자리가 화면에 실제로 있는지 본다.
 * 업무를 몰라도 카드만 따라가면 끊기지 않는 것이 기준이다(docs/verification-rules.md "따라가기 끊김 점검").
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, adminClient, seedWorld, type World, type WorldProduct } from "./harness";
import { recordScanAction, resolveMappingAction, voidScanAction, type ScanResult } from "@/app/dashboard/inbound/actions";
import { setDocumentsScanFinishedAction } from "@/app/dashboard/inbound/document-actions";
import { loadInboundData } from "@/app/dashboard/inbound/inbound-data";
import { INBOUND_ANCHORS, pickFieldNextStep, pickInboundNextStep } from "@/lib/livestock/inbound-next-step";
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

beforeEach(async () => {
  await actAs(world.users.ownerA);
  // 이전 테스트가 남긴 대기 전표가 카드 판단을 흐리지 않게 정리한다.
  await adminClient().from("inbound_documents").update({ status: "DISCARDED" }).eq("wholesaler_id", world.wholesalerA).in("status", ["PENDING", "DRAFT"]);
});

function newProduct(): Promise<WorldProduct> {
  return world.createProduct({ stock_quantity: 0, category: "소", subcategory: "등심" });
}

async function scan(traceNo: string, weight: number) {
  await world.seedTrace(traceNo, { part: "등심" });

  const result = await recordScanAction({ traceNo, weight, scanType: "BARCODE_SCAN" });

  expect(result.success, result.error).toBe(true);

  return result.data as ScanResult;
}

/** 화면이 그리는 두 카드 — 현장(입고 스캔)·사무실(전표입력). */
async function cards() {
  await actAs(world.users.ownerA);

  const data = await loadInboundData(scope, { scanDetails: true });

  return { data, field: pickFieldNextStep(data.nextStepInput), office: pickInboundNextStep(data.nextStepInput) };
}

describe("따라가기 1 — 전표 3줄, 현장이 찍다가 종료를 눌렀다가 더 찍고, 마감된 뒤 한 박스를 취소한다", () => {
  it("단계마다 카드가 다음 할 일을 말하고, 사람이 '다시 시작'·'다시 열기'를 누를 일이 없다", async () => {
    const product = await newProduct();
    const [t1, t2, t3] = [world.newTraceNo(), world.newTraceNo(), world.newTraceNo()];
    const first = await world.createDocumentLine({ traceNo: t1, product, quantity: 1 });

    await world.createDocumentLine({ traceNo: t2, product, quantity: 1, documentId: first.documentId });
    await world.createDocumentLine({ traceNo: t3, product, quantity: 1, documentId: first.documentId });

    // 1. 전표만 올라온 상태 — 현장은 "박스 3개를 더 찍어 주세요"
    let step = await cards();

    expect(step.field.key).toBe("field-scan");
    expect(step.field.title).toContain("3개");
    expect(step.field.href).toBe(INBOUND_ANCHORS.scanForm);

    // 2. 한 박스 — 남은 수가 줄어든다
    await scan(t1, 5);
    step = await cards();
    expect(step.field.title).toContain("2개");

    // 3. 현장이 "스캔 종료" — 현장은 종료 안내, 사무실은 확인·마감으로
    expect(await setDocumentsScanFinishedAction([first.documentId], true)).toEqual({ success: true, data: { changed: 1 } });
    step = await cards();
    expect(step.field.title).toContain("종료");
    expect(step.office.key).toBe("scan-finished");

    // 4. 종료 뒤에 박스가 또 왔다 — 눌러야 할 버튼 없이 다시 "찍는 중"으로 돌아온다
    await scan(t2, 5);
    step = await cards();
    expect(step.field.title).toContain("1개");
    expect(step.field.title).not.toContain("종료");
    expect(step.office.key).not.toBe("scan-finished");

    // 5. 어느 전표 줄에도 없는 박스가 섞여도 남은 수는 그대로다
    const stray = await scan(world.newTraceNo(), 4);

    expect(stray.status).not.toBe("EXCEPTION");
    step = await cards();
    expect(step.field.title).toContain("1개");

    // 6. 마지막 박스 — 전표가 저절로 마감되고 현장은 다음 전표를 기다리는 시작 상태로 돌아간다
    const last = await scan(t3, 5);

    expect(last.autoClosedDocument).toBe(true);
    step = await cards();
    expect(step.data.nextStepInput.pendingDocuments).toHaveLength(0);
    expect(step.field.key).toBe("field-start");

    // 7. 마지막 박스가 잘못 찍힌 것이었다 — 취소하면 전표가 저절로 다시 열리고 그 박스가 다시 "안 온 것"이 된다
    const voided = await voidScanAction(last.scanId);

    expect(voided).toEqual({ success: true, data: { reopenedDocument: true } });
    step = await cards();
    expect(step.data.nextStepInput.pendingDocuments).toHaveLength(1);
    expect(step.field.title).toContain("1개");

    // 8. 다시 찍으면 처음처럼 이어지고 저절로 마감된다
    expect((await scan(t3, 5)).autoClosedDocument).toBe(true);
    step = await cards();
    expect(step.field.key).toBe("field-start");
  });
});

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

    const ids = (await loadInboundData(scope, { scanDetails: false })).products.map((product) => product.id);

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

