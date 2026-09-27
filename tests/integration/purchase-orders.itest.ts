/**
 * 공급처 발주서 — 서버 액션 한 겹(역할 게이트·검증·상태 전이·엑셀 읽기) + 실제 DB(RLS·테넌트 트리거).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import writeExcelFile from "write-excel-file/node";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";
import {
  createPurchaseOrderAction,
  createPurchaseOrderProductAction,
  createSupplierAction,
  parsePurchaseOrderFileAction,
  setPurchaseOrderStatusAction,
  setSupplierActiveAction,
  updateSupplierAction,
  type CreatePurchaseOrderInput,
} from "@/app/dashboard/purchase-orders/actions";
import { buildPurchaseOrderTemplate } from "@/lib/purchase-orders/template";

let world: World;
let supplierAId: string;
let supplierBId: string;

async function seedSupplier(wholesalerId: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await adminClient().from("suppliers").insert({ wholesaler_id: wholesalerId, name, ...extra }).select("id").single();

  if (error || !data) throw new Error(error?.message ?? "거래처 시드 실패");

  return data.id as string;
}

const input = (patch: Partial<CreatePurchaseOrderInput> = {}): CreatePurchaseOrderInput => ({
  supplierId: supplierAId,
  orderedOn: "2026-09-27",
  expectedOn: "",
  note: "",
  lines: [{ category: "소", subcategory: "등심", grade: "1++", origin: "국내산", quantity: "50", unitPrice: "45,000" }],
  ...patch,
});

async function orderRow(id: string) {
  const { data } = await adminClient().from("purchase_orders").select("*, purchase_order_lines(*)").eq("id", id).single();

  return data as Record<string, unknown> & { purchase_order_lines: Array<Record<string, unknown>> };
}

async function xlsxFile(rows: unknown[][], name = "발주서.xlsx"): Promise<File> {
  const buffer = await writeExcelFile([{ data: rows, sheet: "발주서" }] as never).toBuffer();

  return new File([new Uint8Array(buffer)], name);
}

function fileForm(file: File): FormData {
  const data = new FormData();

  data.set("file", file);

  return data;
}

beforeAll(async () => {
  world = await seedWorld();
  supplierAId = await seedSupplier(world.wholesalerA, `테스트축산-${world.runId}`);
  supplierBId = await seedSupplier(world.wholesalerB, `B사 거래처-${world.runId}`);
});

afterAll(async () => {
  await adminClient().from("purchase_orders").delete().eq("wholesaler_id", world.wholesalerA);
  await adminClient().from("suppliers").delete().in("wholesaler_id", [world.wholesalerA, world.wholesalerB]);
  await world?.cleanup();
});

beforeEach(async () => {
  await actAs(world.users.ownerA);
});

describe("발주서 — 권한·격리", () => {
  it("직원·고객·비로그인은 발주서를 만들거나 바꿀 수 없다", async () => {
    const created = await createPurchaseOrderAction(input());

    expect(created.success).toBe(true);

    for (const user of [world.users.staffA, world.users.retailerR, null]) {
      await actAs(user);

      expect((await createPurchaseOrderAction(input({ note: "몰래 발주" }))).success).toBe(false);
      expect((await setPurchaseOrderStatusAction(created.data!.id, "cancel")).success).toBe(false);
      expect((await parsePurchaseOrderFileAction(fileForm(await xlsxFile([["축종", "수량"]])))).success).toBe(false);
    }

    expect((await orderRow(created.data!.id)).status).toBe("OPEN");

    const { count } = await adminClient()
      .from("purchase_orders")
      .select("id", { count: "exact", head: true })
      .eq("note", "몰래 발주");

    expect(count).toBe(0);
  });

  it("매니저는 만들 수 있고, 다른 공급사 사장은 남의 발주서를 바꿀 수 없다", async () => {
    await actAs(world.users.managerA);

    const created = await createPurchaseOrderAction(input({ note: "매니저 발주" }));

    expect(created.success).toBe(true);

    await actAs(world.users.ownerB);

    expect((await setPurchaseOrderStatusAction(created.data!.id, "cancel")).success).toBe(false);
    expect((await orderRow(created.data!.id)).status).toBe("OPEN");
  });

  it("직원은 RLS로 발주서를 조회할 수 있지만 다른 공급사 계정에는 보이지 않는다", async () => {
    const created = await createPurchaseOrderAction(input({ note: "조회 시험" }));
    const client = async (user: Parameters<typeof actAs>[0]) => {
      await actAs(user);
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();
      const { data } = await supabase.from("purchase_orders").select("id").eq("id", created.data!.id);

      return data ?? [];
    };

    expect(await client(world.users.staffA)).toHaveLength(1);
    expect(await client(world.users.ownerB)).toHaveLength(0);
    expect(await client(world.users.retailerR)).toHaveLength(0);
  });
});

describe("createPurchaseOrderAction", () => {
  it("정상 저장 — 헤더·줄이 소유 공급사로 저장되고 값이 다듬어진다", async () => {
    const result = await createPurchaseOrderAction(
      input({
        expectedOn: "2026-09-29",
        note: " 오전 도착 ",
        lines: [
          { category: "소", subcategory: "등심", grade: "1++", origin: "국내산", quantity: "50", unitPrice: "45,000" },
          { category: "돼지", subcategory: "", grade: "", origin: "국내산", quantity: "1,200.5", unitPrice: "" },
        ],
      })
    );

    expect(result.success).toBe(true);

    const row = await orderRow(result.data!.id);
    const lines = [...row.purchase_order_lines].sort((a, b) => Number(a.line_no) - Number(b.line_no));

    expect(row).toMatchObject({ wholesaler_id: world.wholesalerA, supplier_id: supplierAId, supplier_name: `테스트축산-${world.runId}`, note: "오전 도착", status: "OPEN", expected_on: "2026-09-29" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line_no: 1, category: "소", subcategory: "등심", grade: "1++", quantity: 50, unit_price: 45000 });
    expect(lines[1]).toMatchObject({ line_no: 2, category: "돼지", subcategory: null, grade: null, quantity: 1200.5, unit_price: null });
  });

  it("입력 오류는 각각 안내문으로 거부하고 아무것도 저장하지 않는다", async () => {
    const marker = `검증실패-${world.runId}`;
    const cases: Array<[Partial<CreatePurchaseOrderInput>, string]> = [
      [{ supplierId: "" }, "목록에서 골라"],
      [{ supplierId: "00000000-0000-4000-8000-000000000000" }, "찾을 수 없습니다"],
      [{ supplierId: "__B__" }, "찾을 수 없습니다"],
      [{ orderedOn: "" }, "발주일"],
      [{ expectedOn: "2026-09-01", orderedOn: "2026-09-27" }, "빠를 수 없습니다"],
      [{ lines: [] }, "한 줄 이상"],
      [{ lines: [{ category: "말", subcategory: "", grade: "", origin: "국내산", quantity: "5", unitPrice: "" }] }, "알 수 없습니다"],
      [{ lines: [{ category: "소", subcategory: "", grade: "", origin: "", quantity: "5", unitPrice: "" }] }, "원산지"],
      [{ lines: [{ category: "소", subcategory: "", grade: "", origin: "국내산", quantity: "0", unitPrice: "" }] }, "0보다 큰"],
      [{ note: "가".repeat(501) }, "500자"],
    ];

    for (const [patch, message] of cases) {
      const result = await createPurchaseOrderAction(input({ note: marker, ...patch, ...(patch.supplierId === "__B__" ? { supplierId: supplierBId } : {}) }));

      expect(result.success).toBe(false);
      expect(result.error).toContain(message);
    }

    const { count } = await adminClient().from("purchase_orders").select("id", { count: "exact", head: true }).eq("note", marker);

    expect(count).toBe(0);
  });

  it("줄에 오류가 하나라도 있으면 몇 번째 줄인지 알려 주고 발주서 전체가 저장되지 않는다", async () => {
    const marker = `줄오류-${world.runId}`;
    const result = await createPurchaseOrderAction(
      input({
        note: marker,
        lines: [
          { category: "소", subcategory: "", grade: "", origin: "국내산", quantity: "5", unitPrice: "" },
          { category: "소", subcategory: "", grade: "", origin: "국내산", quantity: "x", unitPrice: "" },
        ],
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("2번째 줄");

    const { count } = await adminClient().from("purchase_orders").select("id", { count: "exact", head: true }).eq("note", marker);

    expect(count).toBe(0);
  });

  it("사용 중지한 거래처로는 발주서를 만들 수 없고 다시 사용으로 바꾸면 만들 수 있다", async () => {
    const id = await seedSupplier(world.wholesalerA, `중지 시험-${world.runId}`);

    expect((await setSupplierActiveAction(id, false)).success).toBe(true);

    const blocked = await createPurchaseOrderAction(input({ supplierId: id, note: "중지 거래처" }));

    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain("사용을 중지");

    expect((await setSupplierActiveAction(id, true)).success).toBe(true);
    expect((await createPurchaseOrderAction(input({ supplierId: id, note: "재사용 거래처" }))).success).toBe(true);
  });
});

describe("setPurchaseOrderStatusAction", () => {
  it("마감·취소·다시 열기가 되고 줄은 그대로 남는다", async () => {
    const created = await createPurchaseOrderAction(input({ note: "상태 시험" }));
    const id = created.data!.id;

    expect((await setPurchaseOrderStatusAction(id, "close")).success).toBe(true);
    expect((await orderRow(id)).status).toBe("CLOSED");
    expect((await setPurchaseOrderStatusAction(id, "reopen")).success).toBe(true);
    expect((await setPurchaseOrderStatusAction(id, "cancel")).success).toBe(true);

    const row = await orderRow(id);

    expect(row.status).toBe("CANCELLED");
    expect(row.purchase_order_lines).toHaveLength(1);
    expect((await setPurchaseOrderStatusAction("not-a-uuid", "close")).success).toBe(false);
  });
});

describe("parsePurchaseOrderFileAction — 엑셀 올리기", () => {
  it("내려받은 양식에 채운 줄을 읽고 오류 줄에는 이유를 붙인다(저장은 하지 않는다)", async () => {
    const file = await xlsxFile([
      ["축종", "부위", "등급", "원산지", "수량(kg)", "단가(원/kg)"],
      ["소", "등심", "1++", "국내산", 50, 45000],
      ["말", "", "", "국내산", 5, ""],
    ]);
    const before = (await adminClient().from("purchase_orders").select("id", { count: "exact", head: true }).eq("wholesaler_id", world.wholesalerA)).count;
    const result = await parsePurchaseOrderFileAction(fileForm(file));

    expect(result.success).toBe(true);
    expect(result.data!.rows).toHaveLength(2);
    expect(result.data!.rows[0]).toMatchObject({ error: null, input: { category: "소", subcategory: "등심", quantity: "50", unitPrice: "45000" } });
    expect(result.data!.rows[1].error).toContain("알 수 없습니다");

    const after = (await adminClient().from("purchase_orders").select("id", { count: "exact", head: true }).eq("wholesaler_id", world.wholesalerA)).count;

    expect(after).toBe(before);
  });

  it("빈 양식·엑셀이 아닌 파일·머리글 없는 파일은 안내문으로 거부한다", async () => {
    const blank = await parsePurchaseOrderFileAction(fileForm(new File([new Uint8Array(await buildPurchaseOrderTemplate(["소"]))], "빈양식.xlsx")));

    expect(blank.success).toBe(false);
    expect(blank.error).toContain("올릴 줄이 없습니다");

    const notExcel = await parsePurchaseOrderFileAction(fileForm(new File(["hello"], "메모.txt")));

    expect(notExcel.success).toBe(false);
    expect(notExcel.error).toContain(".xlsx");

    const noHeader = await parsePurchaseOrderFileAction(fileForm(await xlsxFile([["품목", "kg"], ["등심", 5]])));

    expect(noHeader.success).toBe(false);
    expect(noHeader.error).toContain("머리글");

    const missing = await parsePurchaseOrderFileAction(new FormData());

    expect(missing.success).toBe(false);
  });
});

describe("거래처 관리", () => {
  it("등록 — 이름은 공백이 다듬어지고 연락처·메모·별칭이 저장되며 소유 공급사는 서버가 정한다", async () => {
    const name = `  새   거래처-${world.runId}  `;
    const result = await createSupplierAction({ name, phone: " 010-1234-5678 ", note: " 메모 ", aliases: "새거래처별칭, 다른 별칭" });

    expect(result.success).toBe(true);
    expect(result.data!.name).toBe(`새 거래처-${world.runId}`);

    const { data } = await adminClient().from("suppliers").select("*").eq("id", result.data!.id).single();

    expect(data).toMatchObject({ wholesaler_id: world.wholesalerA, phone: "010-1234-5678", note: "메모", aliases: ["새거래처별칭", "다른 별칭"], is_active: true });
    expect(data!.name_key).toBe(`새거래처-${world.runId}`.toLowerCase());
  });

  it("같은 거래처를 공백·대소문자만 바꿔 또 등록하거나 다른 거래처의 이름·별칭과 겹치게 하면 거부한다", async () => {
    const base = `중복시험-${world.runId}`;
    const first = await createSupplierAction({ name: base, phone: "", note: "", aliases: `별칭${world.runId}` });

    expect(first.success).toBe(true);

    const spaced = await createSupplierAction({ name: base.replace("시험", " 시 험").toUpperCase(), phone: "", note: "", aliases: "" });
    const aliasCollision = await createSupplierAction({ name: `다른곳-${world.runId}`, phone: "", note: "", aliases: `별칭${world.runId}` });

    expect(spaced.success).toBe(false);
    expect(spaced.error).toContain(base);
    expect(aliasCollision.success).toBe(false);
    expect(aliasCollision.error).toContain("이미 등록된 거래처");

    // 다른 공급사는 같은 이름을 써도 된다(업체별 목록).
    await actAs(world.users.ownerB);
    expect((await createSupplierAction({ name: base, phone: "", note: "", aliases: "" })).success).toBe(true);
  });

  it("수정은 자기 자신과 겹치는 것은 허용하고 다른 거래처와 겹치면 거부하며, 다른 공급사 거래처는 못 고친다", async () => {
    const a = await createSupplierAction({ name: `수정A-${world.runId}`, phone: "", note: "", aliases: "" });
    const b = await createSupplierAction({ name: `수정B-${world.runId}`, phone: "", note: "", aliases: "" });

    expect((await updateSupplierAction(a.data!.id, { name: `수정A-${world.runId}`, phone: "02-1", note: "", aliases: "" })).success).toBe(true);
    expect((await updateSupplierAction(a.data!.id, { name: `수정b-${world.runId}`, phone: "", note: "", aliases: "" })).success).toBe(false);

    await actAs(world.users.ownerB);

    expect((await updateSupplierAction(b.data!.id, { name: "탈취", phone: "", note: "", aliases: "" })).success).toBe(false);
    expect((await setSupplierActiveAction(b.data!.id, false)).success).toBe(false);

    const { data } = await adminClient().from("suppliers").select("name, is_active").eq("id", b.data!.id).single();

    expect(data).toMatchObject({ name: `수정B-${world.runId}`, is_active: true });
  });

  it("직원·고객·비로그인은 거래처를 만들거나 바꿀 수 없고, 직원은 RLS로 조회만 된다", async () => {
    for (const user of [world.users.staffA, world.users.retailerR, null]) {
      await actAs(user);

      expect((await createSupplierAction({ name: `몰래-${world.runId}`, phone: "", note: "", aliases: "" })).success).toBe(false);
      expect((await setSupplierActiveAction(supplierAId, false)).success).toBe(false);
    }

    await actAs(world.users.staffA);

    const { createClient } = await import("@/lib/supabase/server");
    const { data } = await (await createClient()).from("suppliers").select("id").eq("id", supplierAId);

    expect(data).toHaveLength(1);

    await actAs(world.users.ownerB);

    const { data: hidden } = await (await createClient()).from("suppliers").select("id").eq("id", supplierAId);

    expect(hidden).toHaveLength(0);
  });

  it("입력 오류는 안내문으로 거부한다", async () => {
    for (const [patch, message] of [
      [{ name: "  " }, "이름을 입력"],
      [{ phone: "1".repeat(31) }, "30자"],
      [{ aliases: Array.from({ length: 11 }, (_, index) => `별칭${index}`).join(",") }, "10개"],
    ] as Array<[Partial<Parameters<typeof createSupplierAction>[0]>, string]>) {
      const result = await createSupplierAction({ name: `오류-${world.runId}`, phone: "", note: "", aliases: "", ...patch });

      expect(result.success).toBe(false);
      expect(result.error).toContain(message);
    }
  });
});

describe("DB 방어선", () => {
  it("발주서에 다른 공급사의 거래처를 붙이면 트리거가 막고, 거래처 이름 열쇠는 DB가 유일하게 지킨다", async () => {
    const mismatch = await adminClient().from("purchase_orders").insert({ wholesaler_id: world.wholesalerA, supplier_id: supplierBId, supplier_name: "x" });

    expect(mismatch.error?.message).toContain("SUPPLIER_TENANT_MISMATCH");

    const duplicate = await adminClient().from("suppliers").insert({ wholesaler_id: world.wholesalerA, name: ` 테스트 축산-${world.runId} ` });

    expect(duplicate.error?.code).toBe("23505");
  });

  it("다른 공급사 발주서에 줄을 끼워 넣으면 트리거가 막는다", async () => {
    const created = await createPurchaseOrderAction(input({ note: "테넌트 시험" }));
    const { error } = await adminClient().from("purchase_order_lines").insert({
      purchase_order_id: created.data!.id,
      wholesaler_id: world.wholesalerB,
      line_no: 99,
      category: "소",
      origin: "국내산",
      quantity: 1,
    });

    expect(error?.message).toContain("PURCHASE_ORDER_TENANT_MISMATCH");
  });

  it("수량 0 이하·같은 줄 번호 중복은 CHECK·UNIQUE가 막는다", async () => {
    const created = await createPurchaseOrderAction(input({ note: "제약 시험" }));
    const base = { purchase_order_id: created.data!.id, wholesaler_id: world.wholesalerA, category: "소", origin: "국내산" };
    const zero = await adminClient().from("purchase_order_lines").insert({ ...base, line_no: 50, quantity: 0 });
    const duplicate = await adminClient().from("purchase_order_lines").insert({ ...base, line_no: 1, quantity: 3 });

    expect(zero.error).not.toBeNull();
    expect(duplicate.error).not.toBeNull();
  });
});

describe("발주서 줄 ↔ 등록된 상품 연결 (마이그레이션 138)", () => {
  const line = (patch: Record<string, string> = {}) => ({ category: "소", subcategory: "등심", grade: "1++", origin: "국내산", quantity: "10", unitPrice: "", productId: "", ...patch });
  const linesOf = async (id: string) => [...(await orderRow(id)).purchase_order_lines].sort((a, b) => Number(a.line_no) - Number(b.line_no));

  it("상품을 고른 줄은 스펙을 상품에서 가져오고(보낸 값은 무시), 안 고른 줄은 스펙이 같은 상품에 자동으로 잇는다", async () => {
    const beef = await world.createProduct({ category: "소", subcategory: "우삼겹", grade: "2", origin: "미국산", name: "우삼겹 2" });
    const legacy = await world.createProduct({ category: "소", subcategory: "사태", grade: "3", origin: "호주", name: "사태 3" });
    const pork = await world.createProduct({ category: "돼지", subcategory: "갈비", origin: "국내산", name: "갈비" });

    const created = await createPurchaseOrderAction(
      input({
        lines: [
          line({ productId: beef.id, category: "돼지", subcategory: "엉뚱", grade: "특", origin: "한국" }),
          line({ category: "소", subcategory: "우삼겹", grade: "2", origin: "미국산" }),
          line({ category: "돼지", subcategory: "갈비", grade: "아무거나", origin: "국내산" }),
          line({ category: "소", subcategory: "다짐육", grade: "3", origin: "호주산" }),
          line({ category: "소", subcategory: "사태", grade: "3", origin: "호주산" }),
        ],
      })
    );

    expect(created.success).toBe(true);

    const lines = await linesOf(created.data!.id);

    expect(lines[0]).toMatchObject({ product_id: beef.id, category: "소", subcategory: "우삼겹", grade: "2", origin: "미국산" });
    expect(lines[1]).toMatchObject({ product_id: beef.id });
    expect(lines[2]).toMatchObject({ product_id: pork.id });
    expect(lines[3].product_id).toBeNull();
    expect(lines[4]).toMatchObject({ product_id: legacy.id });
  });

  it("남의 공급사 상품·보관된 상품·없는 상품을 고른 줄은 거부한다", async () => {
    const mine = await world.createProduct({ category: "가공육", subcategory: null, grade: null, origin: "국내산", name: `보관시험-${world.runId}` });
    const { data: other } = await adminClient()
      .from("products")
      .insert({ wholesaler_id: world.wholesalerB, name: "B사 상품", category: "가공육", origin: "국내산", base_price: 0, unit: "kg", stock_quantity: 0, is_active: false })
      .select("id")
      .single();

    await adminClient().from("products").update({ archived_at: new Date().toISOString() }).eq("id", mine.id);

    for (const productId of [other!.id as string, mine.id, "00000000-0000-4000-8000-000000000000"]) {
      const result = await createPurchaseOrderAction(input({ note: `연결거부-${world.runId}`, lines: [line({ productId })] }));

      expect(result.success).toBe(false);
      expect(result.error).toContain("선택한 품목을 찾을 수 없습니다");
    }

    const tenantMismatch = await adminClient().from("purchase_orders").insert({ wholesaler_id: world.wholesalerA, supplier_id: supplierAId, supplier_name: "x" }).select("id").single();
    const dbGuard = await adminClient().from("purchase_order_lines").insert({ purchase_order_id: tenantMismatch.data!.id, wholesaler_id: world.wholesalerA, line_no: 1, category: "소", origin: "국내산", quantity: 1, product_id: other!.id });

    expect(dbGuard.error?.message).toContain("PURCHASE_ORDER_PRODUCT_MISMATCH");
  });

  it("엑셀을 올리면 스펙이 맞는 줄은 상품 ID가 채워지고 맞는 상품이 없는 줄은 비어 있다", async () => {
    const product = await world.createProduct({ category: "소", subcategory: "채끝", grade: "1", origin: "호주", name: "채끝 1" });
    const result = await parsePurchaseOrderFileAction(
      fileForm(
        await xlsxFile([
          ["축종", "부위", "등급", "원산지", "수량(kg)"],
          ["소", "채끝", "1", "호주산", "20"],
          ["소", "채끝", "1", "캐나다산", "20"],
          ["소", "등신", "1", "국내산", "20"],
        ])
      )
    );

    expect(result.success).toBe(true);
    expect(result.data!.rows.map((row) => row.input.productId)).toEqual([product.id, "", ""]);
    expect(result.data!.rows[2].error).toContain("목록에 없습니다");
  });
});

describe("createPurchaseOrderProductAction — 발주서에서 새 품목 만들기", () => {
  const spec = (patch: Record<string, string> = {}) => ({ category: "소", subcategory: "다짐육", grade: "1+", origin: "브라질산", name: "", ...patch });
  const productRow = async (id: string) => (await adminClient().from("products").select("*").eq("id", id).single()).data as Record<string, unknown>;

  it("소는 이름이 자동 조합되고 판매중지·0원으로 만들어지며, 같은 품목을 다시 만들면 새로 만들지 않는다", async () => {
    const first = await createPurchaseOrderProductAction(spec());

    expect(first.success).toBe(true);
    expect(first.data!.created).toBe(true);
    expect(await productRow(first.data!.product.id)).toMatchObject({ wholesaler_id: world.wholesalerA, name: "다짐육 1+", category: "소", origin: "브라질산", is_active: false, base_price: 0, stock_quantity: 0 });

    const again = await createPurchaseOrderProductAction(spec());

    expect(again.data).toMatchObject({ created: false });
    expect(again.data!.product.id).toBe(first.data!.product.id);
  });

  it("돼지·닭·오리·계란은 키 칸만으로 만들어지고 오류는 안내문으로 거부한다", async () => {
    const pork = await createPurchaseOrderProductAction(spec({ category: "돼지", subcategory: "가브리살", grade: "", origin: "스페인산" }));
    const chicken = await createPurchaseOrderProductAction(spec({ category: "닭", subcategory: "", grade: "", origin: "브라질산" }));

    expect(pork.data).toMatchObject({ created: true });
    expect((await productRow(pork.data!.product.id)).name).toBe("가브리살");
    expect(chicken.data).toMatchObject({ created: true });
    expect((await productRow(chicken.data!.product.id)).name).toBe("닭");

    const cases: Array<[Record<string, string>, string]> = [
      [{ subcategory: "" }, "부위를 골라"],
      [{ grade: "" }, "등급을 골라"],
      [{ origin: "한국" }, "목록에 없습니다"],
      [{ category: "말" }, "알 수 없습니다"],
      [{ category: "양", subcategory: "", grade: "", origin: "호주산", name: "" }, "상품명"],
    ];

    for (const [patch, message] of cases) {
      const result = await createPurchaseOrderProductAction(spec(patch));

      expect(result.success).toBe(false);
      expect(result.error).toContain(message);
    }

    const sheep = await createPurchaseOrderProductAction(spec({ category: "양", subcategory: "", grade: "", origin: "호주산", name: `양시험-${world.runId}` }));

    expect(sheep.data).toMatchObject({ created: true });
    expect((await productRow(sheep.data!.product.id)).name).toBe(`양시험-${world.runId}`);
  });

  it("직원·고객·비로그인은 새 품목을 만들 수 없다", async () => {
    for (const user of [world.users.staffA, world.users.retailerR, null]) {
      await actAs(user);

      expect((await createPurchaseOrderProductAction(spec({ origin: "스페인산" }))).success).toBe(false);
    }

    const { count } = await adminClient().from("products").select("id", { count: "exact", head: true }).eq("category", "소").eq("subcategory", "다짐육").eq("origin", "스페인산");

    expect(count).toBe(0);
  });
});

describe("list_product_options — 권한 검사는 한 번, 내 업체 상품만", () => {
  const call = (wholesalerId: string) => getActorClient().rpc("list_product_options", { p_wholesaler_id: wholesalerId, p_categories: null, p_ids: null });

  it("대표·직원은 내 업체 상품을 받고, 다른 업체 사장·고객·비로그인은 거부된다", async () => {
    const product = await world.createProduct({ category: "가공육", subcategory: null, grade: null, origin: "국내산", name: `목록함수-${world.runId}` });

    for (const user of [world.users.ownerA, world.users.staffA]) {
      await actAs(user);

      const result = await call(world.wholesalerA);

      expect(result.error).toBeNull();
      expect((result.data as Array<{ id: string }>).some((row) => row.id === product.id)).toBe(true);
    }

    for (const user of [world.users.ownerB, world.users.retailerR, null]) {
      await actAs(user);

      const result = await call(world.wholesalerA);

      expect(result.error).not.toBeNull();
      expect(result.data).toBeNull();
    }
  });

  it("보관된 상품은 빠지고 축종·상품 ID 필터가 적용된다", async () => {
    await actAs(world.users.ownerA);

    const keep = await world.createProduct({ category: "가공육", subcategory: null, grade: null, origin: "국내산", name: `필터유지-${world.runId}` });
    const archived = await world.createProduct({ category: "가공육", subcategory: null, grade: null, origin: "국내산", name: `필터보관-${world.runId}` });

    await adminClient().from("products").update({ archived_at: new Date().toISOString() }).eq("id", archived.id);

    const all = (await call(world.wholesalerA)).data as Array<{ id: string; category: string }>;

    expect(all.some((row) => row.id === keep.id)).toBe(true);
    expect(all.some((row) => row.id === archived.id)).toBe(false);

    const byIds = (await getActorClient().rpc("list_product_options", { p_wholesaler_id: world.wholesalerA, p_categories: null, p_ids: [keep.id, archived.id] })).data as Array<{ id: string }>;

    expect(byIds.map((row) => row.id)).toEqual([keep.id]);

    const byCategory = (await getActorClient().rpc("list_product_options", { p_wholesaler_id: world.wholesalerA, p_categories: ["양"], p_ids: null })).data as Array<{ category: string }>;

    expect(byCategory.every((row) => row.category === "양")).toBe(true);
  });
});
