import { describe, expect, it } from "vitest";
import { parseImportTable, parseStorageHint } from "./import-parser";

describe("parseStorageHint", () => {
  it("냉장·냉동 표기를 두 값으로 바꾼다", () => {
    expect(parseStorageHint("냉장")).toBe("냉장");
    expect(parseStorageHint(" 냉동육 ")).toBe("냉동");
    expect(parseStorageHint("Frozen")).toBe("냉동");
    expect(parseStorageHint("chilled")).toBe("냉장");
    expect(parseStorageHint("")).toBeNull();
  });
});

describe("parseImportTable 냉장/냉동 열", () => {
  it("셋째 칸이 있으면 읽고, 없으면 null", () => {
    const { rows } = parseImportTable("002123456789\t8.2\t냉동\n002999888777\t7.5");

    expect(rows[0].storageHint).toBe("냉동");
    expect(rows[0].error).toBeNull();
    expect(rows[1].storageHint).toBeNull();
    expect(rows[1].error).toBeNull();
  });

  it("알 수 없는 셋째 칸은 줄 오류", () => {
    const { rows } = parseImportTable("002123456789\t8.2\t상온");

    expect(rows[0].error).toContain("냉장/냉동");
  });
});
