import { describe, expect, it } from "vitest";
import { applyColumnMap, buildGrid, parseTraceCell } from "@/lib/livestock/document-parser";

describe("buildGrid — 이력번호 칸 고르기", () => {
  it("12자리 숫자 칸이 둘이면 축종코드가 맞는 칸을 이력번호로 잡는다(앞 칸이 코드 열이어도)", () => {
    // 1번 칸은 12자리이지만 첫 자리 8·9 → 축종코드가 아님(공급처 자체 코드), 2번 칸이 진짜 이력번호(돼지 1·소 0)
    const grid = buildGrid([
      ["돼지 삼겹살", "812345678901", "140077000150", "10"],
      ["한우 등심", "912345678902", "002191840078", "5"],
      ["돼지 목살", "812345678903", "140077000151", "8"],
    ]);

    expect(grid.columnMap.traceNo).toBe(2);
    // 같은 종류(개체)의 번호 칸이 둘이면 어느 게 묶음번호인지 모른다 — 묶음번호 칸은 잡지 않는다.
    expect(grid.columnMap.lotNo).toBeUndefined();
  });

  it("칸이 하나뿐이면 예전처럼 그 칸이다", () => {
    const grid = buildGrid([
      ["돼지 삼겹살", "140077000150", "10"],
      ["한우 등심", "002191840078", "5"],
    ]);

    expect(grid.columnMap.traceNo).toBe(1);
  });
});

describe("parseTraceCell — 칸 하나에서 번호 전부 뽑기", () => {
  it("정식 형태(12자리·L+14·15자리)는 그대로", () => {
    expect(parseTraceCell("002191840078").traceNos).toEqual(["002191840078"]);
    expect(parseTraceCell("l12512266043001").traceNos).toEqual(["L12512266043001"]);
    expect(parseTraceCell("123456789012345").traceNos).toEqual(["123456789012345"]);
  });

  it("한 칸에 여러 번호 — 쉼표·슬래시·공백·줄바꿈 어느 것으로 나뉘어도 전부", () => {
    expect(parseTraceCell("002191840078, 002191840079").traceNos).toEqual(["002191840078", "002191840079"]);
    expect(parseTraceCell("002191840078/002191840079\n002191840080").traceNos).toHaveLength(3);
    expect(parseTraceCell("002191840078 002191840079").traceNos).toHaveLength(2);
    // 같은 번호가 두 번 적혀 있으면 같은 개체의 박스가 둘이라는 뜻 — 두 번 그대로
    expect(parseTraceCell("002191840078, 002191840078").traceNos).toEqual(["002191840078", "002191840078"]);
  });

  it("하이픈·공백·점으로 끊어 적은 번호는 이어 붙여 읽는다", () => {
    expect(parseTraceCell("002-1918-40078").traceNos).toEqual(["002191840078"]);
    expect(parseTraceCell("0021 9184 0078").traceNos).toEqual(["002191840078"]);
    expect(parseTraceCell("002.1918.40078").traceNos).toEqual(["002191840078"]);
    expect(parseTraceCell("L125-1226-6043-001").traceNos).toEqual(["L12512266043001"]);
    // 끊어 적은 번호가 쉼표로 여러 개
    expect(parseTraceCell("002-1918-40078, 002-1918-40079").traceNos).toEqual(["002191840078", "002191840079"]);
  });

  it("라벨이 같이 적혀 있어도 번호만", () => {
    expect(parseTraceCell("이력번호: 002191840078").traceNos).toEqual(["002191840078"]);
    expect(parseTraceCell("이력번호 002-1918-40078").traceNos).toEqual(["002191840078"]);
  });

  it("엑셀이 앞의 0을 떨어뜨린 소 번호는 이력번호 칸으로 확정된 뒤에만 채운다", () => {
    expect(parseTraceCell("2191840078", { allowZeroPad: true }).traceNos).toEqual(["002191840078"]);
    expect(parseTraceCell("2191840078").traceNos).toEqual([]);
    // 8자리 미만은 채우지 않는다 — 금액·수량일 가능성이 더 크다
    expect(parseTraceCell("1234567", { allowZeroPad: true }).traceNos).toEqual([]);
  });

  it("과학표기 — 유효숫자가 다 있으면 복원, 잘렸으면 만들어내지 않고 truncated", () => {
    expect(parseTraceCell("1.4007700015E+11")).toEqual({ traceNos: ["140077000150"], truncated: false });
    expect(parseTraceCell("1.40077000150e+11").traceNos).toEqual(["140077000150"]);
    expect(parseTraceCell("1.4008E+11")).toEqual({ traceNos: [], truncated: true });
    // 엑셀 일반 형식의 전형적인 잘림(유효숫자 6자리)
    expect(parseTraceCell("1.40077E+11")).toEqual({ traceNos: [], truncated: true });
    // 끝자리 0이 두 개 생략된 것까지는 진짜 번호로 본다
    expect(parseTraceCell("1.400770001E+11").traceNos).toEqual(["140077000100"]);
    // 소 번호는 0으로 시작해 엑셀이 2.19E+9처럼 내보낸다 — 유효숫자가 다 있으면 0을 채워 복원
    expect(parseTraceCell("2.191840078E+9", { allowZeroPad: true }).traceNos).toEqual(["002191840078"]);
  });

  it("바코드 원문·QR URL은 그 안에서 번호 하나", () => {
    expect(parseTraceCell("https://mtrace.go.kr/?traceNo=002191840078").traceNos).toEqual(["002191840078"]);
    expect(parseTraceCell("(01)08801234567893(3103)008200(251)002191840078").traceNos).toEqual(["002191840078"]);
  });

  it("번호가 아닌 값은 빈 배열", () => {
    expect(parseTraceCell("한우 등심 1++").traceNos).toEqual([]);
    expect(parseTraceCell("1,250,000").traceNos).toEqual([]);
    expect(parseTraceCell("").traceNos).toEqual([]);
  });
});

describe("buildGrid — 묶음번호 칸과 이력번호 칸이 나란히", () => {
  it("헤더에 둘 다 있으면 각각 잡는다", () => {
    const grid = buildGrid([
      ["품목", "묶음번호", "이력번호", "중량"],
      ["돼지 삼겹살", "L12512266043001", "150070100622", "10"],
      ["돼지 삼겹살", "L12512266043001", "150070100623", "9.5"],
    ]);

    expect(grid.columnMap.lotNo).toBe(1);
    expect(grid.columnMap.traceNo).toBe(2);
  });

  it("헤더에 '로트'·'LOT'만 있으면(이력번호 칸 없음) 그 칸이 번호 칸이다 — 로트 단위 거래", () => {
    expect(buildGrid([["품목", "로트번호", "중량"], ["돼지 삼겹살", "L12512266043001", "10"]]).columnMap).toMatchObject({
      traceNo: 1,
    });
    expect(buildGrid([["품목", "LOT No", "중량"], ["돼지 삼겹살", "L12512266043001", "10"]]).columnMap.traceNo).toBe(1);
    expect(buildGrid([["품목", "LOT No", "중량"], ["돼지 삼겹살", "L12512266043001", "10"]]).columnMap.lotNo).toBeUndefined();
  });

  it("'이력(묶음)번호'처럼 둘이 한 헤더에 적혀 있으면 이력번호 칸이다", () => {
    expect(buildGrid([["품목", "이력(묶음)번호", "중량"], ["한우 등심", "002191840078", "8"]]).columnMap.traceNo).toBe(1);
  });

  it("헤더가 없어도 개체 칸과 묶음 칸이 따로 있으면 내용으로 가른다", () => {
    const grid = buildGrid([
      ["돼지 삼겹살", "L12512266043001", "150070100622", "10"],
      ["돼지 삼겹살", "L12512266043001", "150070100623", "9.5"],
      ["돼지 목살", "L12512266043002", "150070100624", "8"],
    ]);

    expect(grid.columnMap.traceNo).toBe(2);
    expect(grid.columnMap.lotNo).toBe(1);
  });

  it("헤더 이름과 내용이 뒤바뀐 서식(묶음번호 칸에 12자리, 이력번호 칸에 L…)은 내용대로 바로잡는다", () => {
    const grid = buildGrid([
      ["품목", "이력번호", "묶음번호", "중량"],
      ["돼지 삼겹살", "L12512266043001", "150070100622", "10"],
      ["돼지 삼겹살", "L12512266043001", "150070100623", "9.5"],
    ]);

    expect(grid.columnMap.lotNo).toBe(1);
    expect(grid.columnMap.traceNo).toBe(2);
  });
});

describe("applyColumnMap — 번호 여럿·부속 줄·흐트러진 표기", () => {
  it("한 칸에 이력번호가 3개면 3줄로 나누고, 중량·수량·금액은 첫 줄에만, 단가는 전부", () => {
    const grid = buildGrid([
      ["품목", "이력번호", "수량", "중량", "단가", "금액"],
      ["한우 등심 1++", "002191840078, 002191840079, 002191840080", "3", "24.5", "50000", "1225000"],
    ]);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.traceNo)).toEqual(["002191840078", "002191840079", "002191840080"]);
    expect(lines.map((line) => line.itemName)).toEqual(["한우 등심 1++", "한우 등심 1++", "한우 등심 1++"]);
    expect(lines[0]).toMatchObject({ quantity: 3, labeledWeight: 24.5, unitPrice: 50000, amount: 1225000, splitOf: { index: 0, count: 3 } });
    expect(lines[1]).toMatchObject({ quantity: null, labeledWeight: null, unitPrice: 50000, amount: null, splitOf: { index: 1, count: 3 } });
    expect(lines[2].splitOf).toEqual({ index: 2, count: 3 });
    expect(lines.map((line) => line.lineNo)).toEqual([1, 2, 3]);
  });

  it("같은 개체가 3박스 — 번호 하나에 수량 3이면 한 줄 그대로(나누지 않는다), 번호가 세 번 적혀 있으면 3줄", () => {
    const one = buildGrid([["품목", "이력번호", "수량", "중량"], ["한우 등심", "002191840078", "3", "24.5"]]);
    const oneLines = applyColumnMap(one, one.columnMap);

    expect(oneLines).toHaveLength(1);
    expect(oneLines[0]).toMatchObject({ traceNo: "002191840078", quantity: 3, splitOf: null });

    const repeated = buildGrid([
      ["품목", "이력번호", "수량", "중량"],
      ["한우 등심", "002191840078 / 002191840078 / 002191840078", "3", "24.5"],
    ]);
    const repeatedLines = applyColumnMap(repeated, repeated.columnMap);

    expect(repeatedLines.map((line) => line.traceNo)).toEqual(["002191840078", "002191840078", "002191840078"]);
    expect(repeatedLines[0].quantity).toBe(3);
  });

  it("번호가 하나뿐인 줄은 나누지 않고 splitOf도 없다", () => {
    const grid = buildGrid([["품목", "이력번호", "중량"], ["한우 등심", "002191840078", "8.2"]]);
    const [line] = applyColumnMap(grid, grid.columnMap);

    expect(line.splitOf).toBeNull();
    expect(line.raw).not.toContain("이력번호 1/1");
  });

  it("품목 줄 아래 '이력번호: …' 부속 줄은 위 줄에 붙는다(칸이 어긋나 첫 칸에 와도)", () => {
    const grid = buildGrid([
      ["품목", "중량", "단가", "금액"],
      ["한우 등심 1++", "8.2", "52000", "426400"],
      ["이력번호: 002191840078", "", "", ""],
      ["한우 채끝 1+", "7.5", "41000", "307500"],
      ["002-1918-40079", "", "", ""],
    ]);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ itemName: "한우 등심 1++", traceNo: "002191840078", labeledWeight: 8.2 });
    expect(lines[1]).toMatchObject({ itemName: "한우 채끝 1+", traceNo: "002191840079", labeledWeight: 7.5 });
  });

  it("부속 줄에 번호가 여럿이면 위 줄이 그 수만큼 나뉜다", () => {
    const grid = buildGrid([
      ["품목", "중량", "단가", "금액"],
      ["한우 등심 1++", "16.4", "52000", "852800"],
      ["이력번호 002191840078 / 002191840079", "", "", ""],
    ]);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.traceNo)).toEqual(["002191840078", "002191840079"]);
    expect(lines[0].labeledWeight).toBe(16.4);
    expect(lines[1].labeledWeight).toBeNull();
  });

  it("번호와 중량이 같이 있는 줄은 부속 줄이 아니다 — 그대로 한 줄", () => {
    const grid = buildGrid([
      ["품목", "이력번호", "중량"],
      ["한우 등심 1++", "002191840078", "8.2"],
      ["", "002191840079", "7.9"],
    ]);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ traceNo: "002191840079", labeledWeight: 7.9 });
  });

  it("번호만 나열된 문서(위 줄도 번호만)는 합치지 않고 줄대로 둔다", () => {
    const grid = buildGrid([["002191840078"], ["002191840079"]]);
    const lines = applyColumnMap(grid, { traceNo: 0 });

    expect(lines.map((line) => line.traceNo)).toEqual(["002191840078", "002191840079"]);
    expect(lines.every((line) => line.splitOf === null)).toBe(true);
  });

  it("이력번호 칸의 0 탈락·하이픈은 복원되고, 과학표기로 잘린 건 번호 없이 traceTruncated", () => {
    const grid = buildGrid([
      ["품목", "이력번호", "중량"],
      ["한우 등심", "2191840078", "8.2"],
      ["한우 채끝", "002-1918-40079", "7.5"],
      ["한우 안심", "2.1918E+9", "3.1"],
    ]);
    const lines = applyColumnMap(grid, { traceNo: 1, itemName: 0, labeledWeight: 2 });

    expect(lines[0]).toMatchObject({ traceNo: "002191840078", traceTruncated: false });
    expect(lines[1].traceNo).toBe("002191840079");
    expect(lines[2]).toMatchObject({ traceNo: null, traceTruncated: true, itemName: "한우 안심" });
  });

  it("두 칸 서식은 줄마다 묶음번호와 이력번호를 따로 담는다", () => {
    const grid = buildGrid([
      ["품목", "묶음번호", "이력번호", "중량"],
      ["돼지 삼겹살", "L12512266043001", "150070100622", "10"],
      ["돼지 삼겹살", "L12512266043001", "", "9.5"],
    ]);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines[0]).toMatchObject({ lotNo: "L12512266043001", traceNo: "150070100622" });
    expect(lines[1]).toMatchObject({ lotNo: "L12512266043001", traceNo: null });
  });

  it("정식 형태가 아닌 값(공급처 자체 코드)은 원문 그대로 남겨 사람이 본다", () => {
    const grid = buildGrid([["품목", "이력번호", "중량"], ["특수부위", "LOT-2409-01", "5"]]);
    const [line] = applyColumnMap(grid, { traceNo: 1, itemName: 0, labeledWeight: 2 });

    expect(line.traceNo).toBe("LOT-2409-01");
  });
});
