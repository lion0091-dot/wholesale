/**
 * 국세청 사업자등록번호 검증 유틸.
 *
 * 플랫폼(슈퍼관리자)은 공급사 입점 심사 시 두 단계를 거친다.
 *  1) 형식 검증 — 10자리 체크섬(본 모듈). 오타/허위 번호를 즉시 걸러낸다.
 *  2) 서류 검증 — 제출된 사업자등록증 사본을 사람이 대조 후 status를 active로 전환.
 */

/** 국세청 고시 체크섬 가중치 (앞 9자리에 순서대로 적용) */
const CHECKSUM_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];

/** 하이픈/공백을 제거한 숫자만 반환 */
export function normalizeBusinessNumber(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** 000-00-00000 형태로 포맷 (10자리가 아니면 원본 유지) */
export function formatBusinessNumber(value: string | null | undefined): string {
  const digits = normalizeBusinessNumber(value);

  if (digits.length !== 10) {
    return value ?? "";
  }

  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/**
 * 사업자등록번호 체크섬 검증.
 * 마지막 자리는 (10 - (가중합 % 10)) % 10 이어야 한다.
 */
export function isValidBusinessNumber(value: string | null | undefined): boolean {
  const digits = normalizeBusinessNumber(value);

  if (digits.length !== 10) {
    return false;
  }

  const nums = digits.split("").map(Number);

  let sum = nums
    .slice(0, 9)
    .reduce((acc, digit, index) => acc + digit * CHECKSUM_WEIGHTS[index], 0);

  // 9번째 자리는 가중치 5를 곱한 뒤 10으로 나눈 몫을 한 번 더 더한다.
  sum += Math.floor((nums[8] * 5) / 10);

  return (10 - (sum % 10)) % 10 === nums[9];
}

export type DocumentVerificationLevel = "verified" | "reviewing" | "invalid" | "rejected";

export interface DocumentVerification {
  level: DocumentVerificationLevel;
  /** 체크섬 통과 여부 (서류 심사와 무관한 기계 검증 결과) */
  checksumValid: boolean;
  label: string;
  description: string;
}

/**
 * 계정 상태 + 번호 체크섬을 합쳐 사업자등록증 검증 상태를 산출한다.
 * 심사 담당자가 "무엇을 더 확인해야 하는지" 바로 알 수 있도록 문구를 함께 반환한다.
 */
export function resolveDocumentVerification(
  businessNumber: string | null | undefined,
  accountStatus: "pending" | "active" | "suspended" | "rejected"
): DocumentVerification {
  const checksumValid = isValidBusinessNumber(businessNumber);

  if (!checksumValid) {
    return {
      level: "invalid",
      checksumValid,
      label: "번호 오류",
      description: "국세청 체크섬 불일치 — 등록증 사본으로 번호를 재확인해야 합니다.",
    };
  }

  if (accountStatus === "rejected") {
    return {
      level: "rejected",
      checksumValid,
      label: "서류 반려",
      description: "제출 서류가 반려된 계정입니다.",
    };
  }

  if (accountStatus === "pending") {
    return {
      level: "reviewing",
      checksumValid,
      label: "서류 심사중",
      description: "번호 형식은 유효합니다. 등록증 사본 대조 후 승인하세요.",
    };
  }

  return {
    level: "verified",
    checksumValid,
    label: "검증 완료",
    description: "번호 형식 및 등록증 대조가 완료된 공급사입니다.",
  };
}
