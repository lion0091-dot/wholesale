import { describe, expect, it } from "vitest";
import { parseTraceNumber, speciesGroupFromTraceNumber, speciesMentionedIn, traceIdentityKey } from "@/lib/livestock/trace-number";

describe("parseTraceNumber", () => {
  it("소(0) — 개체식별번호, 세부 구조 없음", () => {
    expect(parseTraceNumber("002191840078")).toMatchObject({ species: "소", speciesCode: "0", farmCode: null, serial: null });
  });

  it("돼지(1) — 농장식별번호 6 + 일련번호 5 (실제 번호 140077000150: 농장 400770)", () => {
    expect(parseTraceNumber("140077000150")).toMatchObject({ species: "돼지", farmCode: "400770", serial: "00150" });
  });

  it("닭(2)·오리(5) — 도축장코드 3 + 일련번호 8", () => {
    expect(parseTraceNumber("521060600101")).toMatchObject({ species: "오리", slaughterhouseCode: "210", serial: "60600101" });
    expect(parseTraceNumber("234500000001")).toMatchObject({ species: "닭", slaughterhouseCode: "345", serial: "00000001" });
  });

  it("계란(3) — 발급월일 4 + 표시의무자 3 + 일련번호 4", () => {
    expect(parseTraceNumber("308151230042")).toMatchObject({ species: "계란", issuedMonthDay: "0815", labelerCode: "123", serial: "0042" });
  });

  it("12자리 숫자가 아니거나 축종코드를 모르면 null", () => {
    expect(parseTraceNumber("40077000015")).toBeNull();
    expect(parseTraceNumber("1400770001500")).toBeNull();
    expect(parseTraceNumber("14007700015A")).toBeNull();
    expect(parseTraceNumber("L00000000000001")).toBeNull();
    expect(parseTraceNumber("412345678901")).toBeNull();
    expect(parseTraceNumber("")).toBeNull();
    expect(parseTraceNumber(null)).toBeNull();
  });

  it("앞뒤 공백은 무시한다", () => {
    expect(parseTraceNumber(" 140077000150 ")?.species).toBe("돼지");
  });
});

describe("speciesGroupFromTraceNumber", () => {
  it("카테고리 표기로 옮긴다 — 닭·오리는 '닭/오리', 계란은 카테고리가 없어 null", () => {
    expect(speciesGroupFromTraceNumber("002191840078")).toBe("소");
    expect(speciesGroupFromTraceNumber("140077000150")).toBe("돼지");
    expect(speciesGroupFromTraceNumber("234500000001")).toBe("닭/오리");
    expect(speciesGroupFromTraceNumber("521060600101")).toBe("닭/오리");
    expect(speciesGroupFromTraceNumber("308151230042")).toBeNull();
    expect(speciesGroupFromTraceNumber("abc")).toBeNull();
  });
});

describe("speciesMentionedIn", () => {
  it("품목명에 축종 단어가 하나만 있으면 그 축종", () => {
    expect(speciesMentionedIn("한우 등심 1++")).toBe("소");
    expect(speciesMentionedIn("돼지 삼겹살")).toBe("돼지");
    expect(speciesMentionedIn("한돈 목살")).toBe("돼지");
    expect(speciesMentionedIn("닭가슴살")).toBe("닭");
    expect(speciesMentionedIn("오리 훈제")).toBe("오리");
    expect(speciesMentionedIn("계란 특란")).toBe("계란");
  });

  it("축종 단어가 없거나(부위만) 둘 이상이면 판단하지 않는다", () => {
    expect(speciesMentionedIn("갈비")).toBeNull();
    expect(speciesMentionedIn("등심 1++")).toBeNull();
    expect(speciesMentionedIn("한우 돼지 모듬")).toBeNull();
    expect(speciesMentionedIn("")).toBeNull();
    expect(speciesMentionedIn(null)).toBeNull();
  });

  it("'오리지널' 같은 단어에 걸리지 않는다", () => {
    expect(speciesMentionedIn("오리지널 소스")).toBeNull();
  });
});

describe("traceIdentityKey — DB의 trace_identity_key()와 같은 값", () => {
  it("돼지 농장·닭 오리 도축장·계란 발급월일+표시의무자", () => {
    expect(traceIdentityKey("140077000150")).toBe("돼지:400770");
    expect(traceIdentityKey("234500000001")).toBe("닭:345");
    expect(traceIdentityKey("521060600101")).toBe("오리:210");
    expect(traceIdentityKey("308151230042")).toBe("계란:0815-123");
  });

  it("같은 출처의 다른 일련번호는 같은 키, 출처가 다르면 다른 키, 닭과 오리는 도축장이 같아도 다르다", () => {
    expect(traceIdentityKey("140077000150")).toBe(traceIdentityKey("140077000199"));
    expect(traceIdentityKey("140077000150")).not.toBe(traceIdentityKey("140081700699"));
    expect(traceIdentityKey("221000000001")).not.toBe(traceIdentityKey("521000000001"));
  });

  it("소(코드 0)·형식 밖 번호는 null", () => {
    expect(traceIdentityKey("002191840078")).toBeNull();
    expect(traceIdentityKey("912345678901")).toBeNull();
    expect(traceIdentityKey("L12512266043001")).toBeNull();
    expect(traceIdentityKey(null)).toBeNull();
  });
});
