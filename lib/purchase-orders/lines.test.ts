import { describe, expect, it } from "vitest";
import { parseAmount, parsePurchaseOrderCells, validatePurchaseOrderLine } from "./lines";

const CATEGORIES = ["소", "돼지", "닭", "오리", "계란", "가공육/기타"];
const line = (patch: Partial<Parameters<typeof validatePurchaseOrderLine>[0]> = {}) => ({
  category: "소",
  breed: "한우",
  subcategory: "등심",
  grade: "1++",
  sex: "거세",
  bms: "",
  storageState: "냉장",
  origin: "국내산",
  quantity: "50",
  unitPrice: "",
  ...patch,
});

describe("parseAmount", () => {
  it("쉼표·단위 표기를 숫자로 읽고 숫자가 아니면 null", () => {
    expect(parseAmount("1,200")).toBe(1200);
    expect(parseAmount("50kg")).toBe(50);
    expect(parseAmount("68,000원")).toBe(68000);
    expect(parseAmount("7.5")).toBe(7.5);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("-3")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("validatePurchaseOrderLine", () => {
  it("정상 줄은 다듬어서 통과시키고 부위·등급·단가는 비어도 된다", () => {
    expect(validatePurchaseOrderLine(line({ subcategory: "  ", grade: "", unitPrice: "45,000" }), CATEGORIES)).toEqual({
      ok: true,
      line: {
        category: "소",
        breed: "한우",
        subcategory: null,
        grade: null,
        sex: "거세",
        bms: null,
        storageState: "냉장",
        origin: "국내산",
        quantity: 50,
        unitPrice: 45000,
      },
    });
  });

  it("축종·원산지·수량·단가 오류를 각각 안내문으로 거부한다", () => {
    const cases: Array<[Partial<ReturnType<typeof line>>, string]> = [
      [{ category: "" }, "축종을 골라"],
      [{ category: "말" }, "알 수 없습니다"],
      [{ origin: " " }, "원산지를 입력"],
      [{ quantity: "0" }, "0보다 큰"],
      [{ quantity: "abc" }, "0보다 큰"],
      [{ unitPrice: "abc" }, "단가는 0 이상"],
    ];

    for (const [patch, message] of cases) {
      const result = validatePurchaseOrderLine(line(patch), CATEGORIES);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain(message);
    }
  });
});

describe("validatePurchaseOrderLine — 목록에서만 고르는 칸", () => {
  const PARTS = { 소: ["등심", "안심"], 돼지: ["삼겹살", "목살"], 닭: ["통닭"], "가공육/기타": ["소시지"] };
  const check = (patch: Partial<ReturnType<typeof line>>) => validatePurchaseOrderLine(line(patch), CATEGORIES, PARTS);

  it("목록 안의 값은 통과하고 비운 부위·등급도 통과한다", () => {
    expect(check({}).ok).toBe(true);
    expect(check({ category: "돼지", subcategory: "삼겹살", grade: "아무거나" }).ok).toBe(true);
    expect(check({ subcategory: "", grade: "" }).ok).toBe(true);
  });

  it("소·돼지의 목록에 없는 부위, 다른 축종의 부위는 거부한다", () => {
    expect(check({ subcategory: "등신" })).toMatchObject({ ok: false });
    expect(check({ category: "돼지", subcategory: "등심" })).toMatchObject({ ok: false });
  });

  it("소 등급은 목록만, 다른 축종의 등급은 자유", () => {
    expect(check({ grade: "1+ +" })).toMatchObject({ ok: false });
    expect(check({ category: "돼지", subcategory: "목살", grade: "1+ +" }).ok).toBe(true);
  });

  it("소·돼지·닭·오리·계란의 원산지는 목록만, 그 밖의 축종은 자유", () => {
    expect(check({ origin: "한국" })).toMatchObject({ ok: false });
    expect(check({ category: "닭", subcategory: "", origin: "한국" })).toMatchObject({ ok: false });
    expect(check({ category: "오리", subcategory: "아무 부위", origin: "브라질산" }).ok).toBe(true);
    expect(check({ category: "가공육/기타", subcategory: "아무 부위", origin: "한국" }).ok).toBe(true);
  });

  it("엑셀 올리기도 같은 검사를 한다", () => {
    const parsed = parsePurchaseOrderCells(
      [
        ["축종", "품종", "부위", "등급", "성별", "원산지", "냉장/냉동", "수량", "단가"],
        ["소", "한우", "등신", "1++", "거세", "국내산", "냉장", "5", ""],
        ["소", "한우", "등심", "1++", "거세", "국내산", "냉장", "5", ""],
        ["소", "", "등심", "1++", "거세", "국내산", "냉장", "5", ""],
      ],
      CATEGORIES,
      PARTS
    );

    expect(parsed.rows[0].error).toContain("부위");
    expect(parsed.rows[1].error).toBeNull();
    expect(parsed.rows[2].error).toContain("품종");
  });

  it("성별·냉장/냉동 칸이 없으면(옛 양식) 국내산 소·냉장냉동 필요 축종 줄은 거부한다", () => {
    const parsed = parsePurchaseOrderCells(
      [
        ["축종", "품종", "부위", "등급", "원산지", "수량", "단가"],
        ["소", "한우", "등심", "1++", "국내산", "5", ""],
      ],
      CATEGORIES,
      PARTS
    );

    expect(parsed.rows[0].error).toContain("성별");
  });

  it("소는 품종이 필수이고 목록(한우·육우·젖소)만, 다른 축종은 품종이 없다", () => {
    expect(check({ breed: "" })).toMatchObject({ ok: false });
    expect(check({ breed: "흑우" })).toMatchObject({ ok: false });
    expect(check({ breed: "육우" })).toMatchObject({ ok: true, line: { breed: "육우" } });
    expect(check({ breed: "젖소" }).ok).toBe(true);
    expect(check({ category: "돼지", subcategory: "삼겹살", breed: "" })).toMatchObject({ ok: true, line: { breed: null } });
    expect(check({ category: "돼지", subcategory: "삼겹살", breed: "한우" })).toMatchObject({ ok: true, line: { breed: null } });
  });

  it("[버그수정] 수입 원산지 소 줄도 품종·성별 값이 있으면 목록 형식을 검사한다(통단테 발견)", () => {
    // 수입산은 품종·성별이 비어도 되지만(위 테스트), 값이 들어있는데 오타/목록 밖이면
    // 원산지와 무관하게 거부해야 한다 — 예전엔 이 형식 검사가 국내산 블록 안에만 있어서
    // 수입산 줄은 그대로 통과돼 저장 시 DB CHECK 위반(안내 없는 원본 오류)으로 터졌다.
    expect(check({ origin: "미국산", breed: "흑우" })).toMatchObject({ ok: false, error: expect.stringContaining("품종") });
    expect(check({ origin: "미국산", sex: "수컷" })).toMatchObject({ ok: false, error: expect.stringContaining("성별") });
    // 수입산은 여전히 비워도 통과(필수 아님).
    expect(check({ origin: "미국산", breed: "", sex: "" }).ok).toBe(true);
    // 수입산이라도 목록 안 값이면 그대로 통과.
    expect(check({ origin: "미국산", breed: "육우", sex: "암" }).ok).toBe(true);
  });

  it("등록된 상품에서 온 스펙(trustSpec)도 소의 품종이 비어 있으면 거부하고 상품 관리에서 채우라고 안내한다", () => {
    const result = validatePurchaseOrderLine(line({ breed: "" }), CATEGORIES, PARTS, { trustSpec: true });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toContain("상품 관리");
    expect(validatePurchaseOrderLine(line({ breed: "한우" }), CATEGORIES, PARTS, { trustSpec: true }).ok).toBe(true);
  });
});

describe("parsePurchaseOrderCells", () => {
  it("머리글 칸 순서가 바뀌어도 이름으로 읽고 빈 줄은 건너뛰며 오류 줄에는 이유를 붙인다", () => {
    const parsed = parsePurchaseOrderCells(
      [
        ["수량(kg)", "축종", "원산지", "등급", "부위", "단가(원/kg)", "품종", "성별", "냉장/냉동"],
        ["50", "소", "국내산", "1++", "등심", "45,000", "육우", "암", "냉장"],
        ["", "", "", "", "", "", "", "", ""],
        ["10", "말", "국내산", "", "", "", "", "", ""],
      ],
      CATEGORIES
    );

    expect(parsed.headerError).toBeNull();
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      rowNo: 2,
      error: null,
      input: { category: "소", breed: "육우", subcategory: "등심", grade: "1++", sex: "암", storageState: "냉장", quantity: "50", unitPrice: "45,000" },
    });
    expect(parsed.rows[1]).toMatchObject({ rowNo: 4 });
    expect(parsed.rows[1].error).toContain("알 수 없습니다");
  });

  it("위쪽에 제목 줄이 있어도 머리글을 찾고, 머리글이 없으면 안내한다", () => {
    const withTitle = parsePurchaseOrderCells(
      [["한우 발주"], ["축종", "품종", "부위", "등급", "원산지", "수량", "단가"], ["소", "한우", "안심", "1+", "국내산", "20", ""]],
      CATEGORIES
    );

    expect(withTitle.rows).toHaveLength(1);
    expect(withTitle.rows[0].rowNo).toBe(3);

    const none = parsePurchaseOrderCells([["품목", "kg"], ["등심", "5"]], CATEGORIES);

    expect(none.rows).toHaveLength(0);
    expect(none.headerError).toContain("머리글");
  });
});
