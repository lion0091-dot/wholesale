import { describe, expect, it } from "vitest";
import {
  formatBusinessNumber,
  isValidBusinessNumber,
  normalizeBusinessNumber,
  resolveDocumentVerification,
} from "@/lib/validation/business-number";

describe("normalizeBusinessNumber / formatBusinessNumber", () => {
  it("하이픈·공백을 제거한다", () => {
    expect(normalizeBusinessNumber("123-45-67890")).toBe("1234567890");
    expect(normalizeBusinessNumber(" 123 45 67890 ")).toBe("1234567890");
  });

  it("10자리면 000-00-00000 형태로 포맷한다", () => {
    expect(formatBusinessNumber("1234567890")).toBe("123-45-67890");
  });

  it("10자리가 아니면 원본을 그대로 돌려준다", () => {
    expect(formatBusinessNumber("123")).toBe("123");
    expect(formatBusinessNumber(null)).toBe("");
  });
});

describe("isValidBusinessNumber", () => {
  it("자릿수가 10자리가 아니면 무조건 실패", () => {
    expect(isValidBusinessNumber("123")).toBe(false);
    expect(isValidBusinessNumber(null)).toBe(false);
    expect(isValidBusinessNumber(undefined)).toBe(false);
  });

  it("체크섬 계산식으로 유효한 번호를 만들어 검증하면 통과한다", () => {
    // 체크섬 규칙을 그대로 재현해 유효한 10자리를 만든 뒤 함수가 같은 결론을 내는지 확인.
    const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    const first9 = [1, 0, 1, 2, 3, 4, 5, 6, 7];
    let sum = first9.reduce((acc, digit, index) => acc + digit * weights[index], 0);
    sum += Math.floor((first9[8] * 5) / 10);
    const checkDigit = (10 - (sum % 10)) % 10;
    const valid = [...first9, checkDigit].join("");

    expect(isValidBusinessNumber(valid)).toBe(true);
    // 마지막 자리를 하나 어긋나게 하면 실패해야 한다.
    const brokenLastDigit = (checkDigit + 1) % 10;
    expect(isValidBusinessNumber([...first9, brokenLastDigit].join(""))).toBe(false);
  });
});

describe("resolveDocumentVerification", () => {
  it("체크섬이 틀리면 계정 상태와 무관하게 invalid", () => {
    const result = resolveDocumentVerification("123-45-67899", "active");

    expect(result.level).toBe("invalid");
  });

  it("체크섬은 맞지만 사업 종료 계정이면 rejected", () => {
    const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    const first9 = [1, 0, 1, 2, 3, 4, 5, 6, 7];
    let sum = first9.reduce((acc, digit, index) => acc + digit * weights[index], 0);
    sum += Math.floor((first9[8] * 5) / 10);
    const checkDigit = (10 - (sum % 10)) % 10;
    const valid = [...first9, checkDigit].join("");

    expect(resolveDocumentVerification(valid, "closed").level).toBe("rejected");
    expect(resolveDocumentVerification(valid, "rejected").level).toBe("rejected");
    expect(resolveDocumentVerification(valid, "pending").level).toBe("reviewing");
    expect(resolveDocumentVerification(valid, "active").level).toBe("verified");
  });
});
