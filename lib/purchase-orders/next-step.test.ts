import { describe, expect, it } from "vitest";
import { HOLDS_PATH, pickHoldsNextStep, pickPurchaseOrdersNextStep, type PurchaseOrdersNextStepInput } from "./next-step";

const base: PurchaseOrdersNextStepInput = {
  canManage: true,
  activeSupplierCount: 2,
  orderCount: 5,
  overdueOrders: [],
  heldCount: 0,
};

const pick = (over: Partial<PurchaseOrdersNextStepInput>) => pickPurchaseOrdersNextStep({ ...base, ...over });

describe("전표관리 지금 할 일 카드 — 상태 표", () => {
  it("직원에게는 카드가 없다", () => {
    expect(pick({ canManage: false, activeSupplierCount: 0 })).toBeNull();
  });

  it("거래처가 없으면 거래처 등록이 가장 먼저(전표가 없어도, 보류가 있어도)", () => {
    expect(pick({ activeSupplierCount: 0, orderCount: 0, heldCount: 3 })?.key).toBe("no-supplier");
    expect(pick({ activeSupplierCount: 0 })?.action.kind).toBe("open-suppliers");
  });

  it("거래처는 있는데 전표가 없으면 첫 전표", () => {
    const step = pick({ orderCount: 0, heldCount: 3 });

    expect(step?.key).toBe("no-order");
    expect(step?.action.kind).toBe("open-form");
  });

  it("도착 예정일이 지난 전표가 보류함보다 먼저, 첫 건으로 이동", () => {
    const step = pick({
      overdueOrders: [
        { id: "a", supplierName: "대한유통", expectedOn: "2026-09-20" },
        { id: "b", supplierName: "한강육가공", expectedOn: "2026-09-25" },
      ],
      heldCount: 2,
    });

    expect(step?.key).toBe("overdue");
    expect(step?.title).toContain("2건");
    expect(step?.detail).toContain("대한유통");
    expect(step?.detail).toContain("외 1건");
    expect(step?.action).toEqual({ kind: "scroll", targetId: "po-a" });
  });

  it("보류가 있으면 보류함으로 보낸다", () => {
    const step = pick({ heldCount: 4 });

    expect(step?.key).toBe("holds");
    expect(step?.action).toEqual({ kind: "link", href: HOLDS_PATH });
    expect(step?.title).toContain("4건");
  });

  it("모두 정상이면 카드가 없다", () => {
    expect(pick({})).toBeNull();
  });
});

describe("보류함 지금 할 일 카드", () => {
  it("보류가 없으면 \"정리할 물건이 없습니다\" + 받지 않은 기록 안내", () => {
    expect(pickHoldsNextStep({ canManage: true, holdCount: 0, rejectionCount: 0, firstScanId: null }).detail).toContain("할 일이 없습니다");
    const step = pickHoldsNextStep({ canManage: true, holdCount: 0, rejectionCount: 3, firstScanId: null });

    expect(step.key).toBe("clear");
    expect(step.detail).toContain("3건");
    expect(step.button).toBeNull();
  });

  it("사장님·매니저는 첫 건으로 가는 버튼을 받는다", () => {
    const step = pickHoldsNextStep({ canManage: true, holdCount: 2, rejectionCount: 0, firstScanId: "s1" });

    expect(step.key).toBe("manage");
    expect(step.button?.href).toBe("#hold-s1");
    expect(step.title).toContain("2건");
  });

  it("직원은 볼 수만 있다(버튼 없음)", () => {
    const step = pickHoldsNextStep({ canManage: false, holdCount: 2, rejectionCount: 0, firstScanId: "s1" });

    expect(step.key).toBe("wait-manager");
    expect(step.button).toBeNull();
  });
});
