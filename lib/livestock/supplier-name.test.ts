import { describe, expect, it } from "vitest";
import { legacySupplierKey, normalizeSupplierName, supplierKey } from "./supplier-name";

describe("공급처 이름 정리", () => {
  it("앞뒤 공백을 자르고 안쪽 연속 공백은 한 칸으로 줄인다(전각 공백·NBSP 포함)", () => {
    expect(normalizeSupplierName("  대성   축산 ")).toBe("대성 축산");
    expect(normalizeSupplierName("대성　축산 ")).toBe("대성 축산");
    expect(normalizeSupplierName(null)).toBe("");
  });

  it("띄어쓰기·대소문자만 다른 이름은 같은 공급처다", () => {
    expect(supplierKey("대성 축산")).toBe(supplierKey("대성축산"));
    expect(supplierKey(" 대성  축산 ")).toBe(supplierKey("대성축산"));
    expect(supplierKey("ABC Meat")).toBe(supplierKey("abcmeat"));
  });

  it("다른 이름은 다른 공급처다", () => {
    expect(supplierKey("대성축산")).not.toBe(supplierKey("대성축산물"));
  });

  it("옛 열쇠는 안쪽 공백을 한 칸으로만 줄인다", () => {
    expect(legacySupplierKey(" 대성   축산 ")).toBe("대성 축산");
  });
});
