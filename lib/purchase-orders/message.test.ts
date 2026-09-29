import { describe, expect, it } from "vitest";
import { buildPurchaseOrderMessage, type PurchaseOrderMessageInput } from "./message";

const base: PurchaseOrderMessageInput = {
  supplierName: "OO축산",
  orderedOn: "2026-09-27",
  expectedOn: "2026-09-29",
  note: null,
  lines: [
    { category: "소", breed: "한우", subcategory: "등심", grade: "1++", sex: "거세", bms: "9", storageState: "냉장", origin: "국내산", quantity: 50, unit: "kg", unitPrice: 45000 },
    { category: "소", breed: "육우", subcategory: "안심", grade: "1+", sex: "암", storageState: "냉동", origin: "국내산", quantity: 20, unit: "kg", unitPrice: null },
    { category: "돼지", subcategory: null, grade: null, storageState: "냉장", origin: "국내산", quantity: 1200.5, unit: "kg", unitPrice: null },
    { category: "소", breed: "한우", subcategory: "채끝", grade: "1", origin: "호주산", quantity: 30, unit: "kg", unitPrice: 30000 },
  ],
};

describe("buildPurchaseOrderMessage", () => {
  it("축종별로 묶고 줄마다 냉장/냉동·품종·부위·등급(BMS)·성별·원산지·수량만 적고 합계를 붙인다(단가 없음이 기본)", () => {
    expect(buildPurchaseOrderMessage(base)).toBe(
      [
        "[발주] OO축산 귀중",
        "발주일 9/27 · 도착 예정 9/29",
        "",
        "■ 소",
        "- 냉장 한우 등심 1++(9) 거세 국내산 50kg",
        "- 냉동 육우 안심 1+ 암 국내산 20kg",
        "- 한우 채끝 1 호주산 30kg",
        "■ 돼지",
        "- 냉장 국내산 1,200.5kg",
        "",
        "합계 1,300.5kg",
      ].join("\n")
    );
  });

  it("단가 포함 옵션이면 단가가 있는 줄에만 붙는다", () => {
    const message = buildPurchaseOrderMessage(base, { includePrice: true });

    expect(message).toContain("- 냉장 한우 등심 1++(9) 거세 국내산 50kg · 45,000원/kg");
    expect(message).toContain("- 냉동 육우 안심 1+ 암 국내산 20kg\n");
  });

  it("도착 예정일이 없으면 발주일만, 메모가 있으면 맨 아래에 적는다", () => {
    const message = buildPurchaseOrderMessage({ ...base, expectedOn: null, note: " 오전 도착 " });

    expect(message.split("\n")[1]).toBe("발주일 9/27");
    expect(message.endsWith("※ 오전 도착")).toBe(true);
  });
});
