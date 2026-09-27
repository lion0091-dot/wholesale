/**
 * 공급처 발주서 — 서버 액션 한 겹(역할 게이트·검증·상태 전이·엑셀 읽기) + 실제 DB(RLS·테넌트 트리거).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import writeExcelFile from "write-excel-file/node";
import { actAs, adminClient, seedWorld, type World } from "./harness";
import {
  createPurchaseOrderAction,
  parsePurchaseOrderFileAction,
  setPurchaseOrderStatusAction,
  type CreatePurchaseOrderInput,
} from "@/app/dashboard/purchase-orders/actions";
import { buildPurchaseOrderTemplate } from "@/lib/purchase-orders/template";

let world: World;

const input = (patch: Partial<CreatePurchaseOrderInput> = {}): CreatePurchaseOrderInput => ({
  supplierName: "테스트축산",
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
});

afterAll(async () => {
  await adminClient().from("purchase_orders").delete().eq("wholesaler_id", world.wholesalerA);
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

      expect((await createPurchaseOrderAction(input({ supplierName: "몰래 발주" }))).success).toBe(false);
      expect((await setPurchaseOrderStatusAction(created.data!.id, "cancel")).success).toBe(false);
      expect((await parsePurchaseOrderFileAction(fileForm(await xlsxFile([["축종", "수량"]])))).success).toBe(false);
    }

    expect((await orderRow(created.data!.id)).status).toBe("OPEN");

    const { count } = await adminClient()
      .from("purchase_orders")
      .select("id", { count: "exact", head: true })
      .eq("supplier_name", "몰래 발주");

    expect(count).toBe(0);
  });

  it("매니저는 만들 수 있고, 다른 공급사 사장은 남의 발주서를 바꿀 수 없다", async () => {
    await actAs(world.users.managerA);

    const created = await createPurchaseOrderAction(input({ supplierName: "매니저 발주" }));

    expect(created.success).toBe(true);

    await actAs(world.users.ownerB);

    expect((await setPurchaseOrderStatusAction(created.data!.id, "cancel")).success).toBe(false);
    expect((await orderRow(created.data!.id)).status).toBe("OPEN");
  });

  it("직원은 RLS로 발주서를 조회할 수 있지만 다른 공급사 계정에는 보이지 않는다", async () => {
    const created = await createPurchaseOrderAction(input({ supplierName: "조회 시험" }));
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
        supplierName: "  좋은축산  ",
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

    expect(row).toMatchObject({ wholesaler_id: world.wholesalerA, supplier_name: "좋은축산", note: "오전 도착", status: "OPEN", expected_on: "2026-09-29" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line_no: 1, category: "소", subcategory: "등심", grade: "1++", quantity: 50, unit_price: 45000 });
    expect(lines[1]).toMatchObject({ line_no: 2, category: "돼지", subcategory: null, grade: null, quantity: 1200.5, unit_price: null });
  });

  it("입력 오류는 각각 안내문으로 거부하고 아무것도 저장하지 않는다", async () => {
    const marker = `검증실패-${world.runId}`;
    const cases: Array<[Partial<CreatePurchaseOrderInput>, string]> = [
      [{ supplierName: " " }, "공급처 이름"],
      [{ orderedOn: "" }, "발주일"],
      [{ expectedOn: "2026-09-01", orderedOn: "2026-09-27" }, "빠를 수 없습니다"],
      [{ lines: [] }, "한 줄 이상"],
      [{ lines: [{ category: "말", subcategory: "", grade: "", origin: "국내산", quantity: "5", unitPrice: "" }] }, "알 수 없습니다"],
      [{ lines: [{ category: "소", subcategory: "", grade: "", origin: "", quantity: "5", unitPrice: "" }] }, "원산지"],
      [{ lines: [{ category: "소", subcategory: "", grade: "", origin: "국내산", quantity: "0", unitPrice: "" }] }, "0보다 큰"],
      [{ note: "가".repeat(501) }, "500자"],
    ];

    for (const [patch, message] of cases) {
      const result = await createPurchaseOrderAction(input({ supplierName: marker, ...patch }));

      expect(result.success).toBe(false);
      expect(result.error).toContain(message);
    }

    const { count } = await adminClient().from("purchase_orders").select("id", { count: "exact", head: true }).eq("supplier_name", marker);

    expect(count).toBe(0);
  });

  it("줄에 오류가 하나라도 있으면 몇 번째 줄인지 알려 주고 발주서 전체가 저장되지 않는다", async () => {
    const marker = `줄오류-${world.runId}`;
    const result = await createPurchaseOrderAction(
      input({
        supplierName: marker,
        lines: [
          { category: "소", subcategory: "", grade: "", origin: "국내산", quantity: "5", unitPrice: "" },
          { category: "소", subcategory: "", grade: "", origin: "국내산", quantity: "x", unitPrice: "" },
        ],
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("2번째 줄");

    const { count } = await adminClient().from("purchase_orders").select("id", { count: "exact", head: true }).eq("supplier_name", marker);

    expect(count).toBe(0);
  });
});

describe("setPurchaseOrderStatusAction", () => {
  it("마감·취소·다시 열기가 되고 줄은 그대로 남는다", async () => {
    const created = await createPurchaseOrderAction(input({ supplierName: "상태 시험" }));
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

describe("DB 방어선", () => {
  it("다른 공급사 발주서에 줄을 끼워 넣으면 트리거가 막는다", async () => {
    const created = await createPurchaseOrderAction(input({ supplierName: "테넌트 시험" }));
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
    const created = await createPurchaseOrderAction(input({ supplierName: "제약 시험" }));
    const base = { purchase_order_id: created.data!.id, wholesaler_id: world.wholesalerA, category: "소", origin: "국내산" };
    const zero = await adminClient().from("purchase_order_lines").insert({ ...base, line_no: 50, quantity: 0 });
    const duplicate = await adminClient().from("purchase_order_lines").insert({ ...base, line_no: 1, quantity: 3 });

    expect(zero.error).not.toBeNull();
    expect(duplicate.error).not.toBeNull();
  });
});
