/** 숫자만 남긴다(하이픈·공백 등 입력 중 흔한 구분자 제거). */
export function normalizePhone(input: string): string {
  return input.replace(/[^0-9]/g, "");
}

/** DB(complete_supplier_signup)와 동일한 최소 기준 — 9자리 이상. */
export function isValidPhone(digitsOnly: string): boolean {
  return digitsOnly.length >= 9;
}
