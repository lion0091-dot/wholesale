/**
 * 공급처 이름 정리. 띄어쓰기·앞뒤 공백·대소문자 차이 때문에 같은 공급처가 둘로 갈라지지 않게 한다
 * (전표 중복 업로드 검사, 칸 배치 기억, 공급처 목록이 모두 이 함수를 쓴다).
 */

/** 눈에 보이는 공백 문자들 — 일반 공백·탭·줄바꿈·NBSP·전각 공백. */
const WHITESPACE = /[\s 　]+/g;

/** 저장·표시할 이름: 앞뒤 공백을 자르고 안쪽 연속 공백은 한 칸으로 줄인다. */
export function normalizeSupplierName(name: string | null | undefined): string {
  return (name ?? "").replace(WHITESPACE, " ").trim();
}

/** 같은 공급처인지 비교하는 열쇠: 모든 공백을 없애고 소문자로 맞춘다("대성 축산"="대성축산"). */
export function supplierKey(name: string | null | undefined): string {
  return (name ?? "").replace(WHITESPACE, "").toLowerCase();
}

/** 예전 열쇠(안쪽 공백을 한 칸으로 줄이기만 함) — 이미 저장된 칸 배치 기억을 찾을 때만 쓴다. */
export function legacySupplierKey(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
