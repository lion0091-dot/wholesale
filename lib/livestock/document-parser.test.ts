import { describe, expect, it } from "vitest";
import { buildGrid } from "@/lib/livestock/document-parser";

describe("buildGrid — 이력번호 칸 고르기", () => {
  it("12자리 숫자 칸이 둘이면 축종코드가 맞는 칸을 이력번호로 잡는다(앞 칸이 코드 열이어도)", () => {
    // 1번 칸은 12자리이지만 첫 자리 8·9 → 축종코드가 아님(공급처 자체 코드), 2번 칸이 진짜 이력번호(돼지 1·소 0)
    const grid = buildGrid([
      ["돼지 삼겹살", "812345678901", "140077000150", "10"],
      ["한우 등심", "912345678902", "002191840078", "5"],
      ["돼지 목살", "812345678903", "140077000151", "8"],
    ]);

    expect(grid.columnMap.traceNo).toBe(2);
  });

  it("칸이 하나뿐이면 예전처럼 그 칸이다", () => {
    const grid = buildGrid([
      ["돼지 삼겹살", "140077000150", "10"],
      ["한우 등심", "002191840078", "5"],
    ]);

    expect(grid.columnMap.traceNo).toBe(1);
  });
});
