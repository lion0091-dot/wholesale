/**
 * 공공데이터포털(data.go.kr) 국세청_사업자등록정보 진위확인 API 클라이언트.
 *
 * 체크섬(lib/validation/business-number.ts)은 형식만 확인하므로 자릿수만 맞으면
 * 실재하지 않는 번호도 통과한다. 이 API는 사업자번호·대표자성명·개업일자를
 * 국세청 실데이터와 직접 대조해 진짜 존재하는 사업자인지 확인한다.
 *
 * 문서: https://www.data.go.kr (검색: 국세청_사업자등록정보 진위확인 및 상태조회 서비스)
 */

const NTS_VALIDATE_ENDPOINT = "https://api.odcloud.kr/api/nts-businessman/v1/validate";

export type NtsVerificationStatus = "match" | "mismatch" | "not_found" | "error";

export interface NtsVerificationInput {
  businessNumber: string;
  representativeName: string;
  /** YYYY-MM-DD */
  startDate: string;
}

export interface NtsVerificationResult {
  status: NtsVerificationStatus;
  message: string;
}

function toNtsDate(value: string): string {
  return value.replace(/-/g, "");
}

/** 국세청 진위확인 API 1건 호출. 네트워크/API 오류는 던지지 않고 status: "error"로 반환한다. */
export async function verifyBusinessRegistration(
  input: NtsVerificationInput
): Promise<NtsVerificationResult> {
  const apiKey = process.env.NTS_BUSINESS_VERIFY_API_KEY;

  if (!apiKey) {
    return {
      status: "error",
      message: "NTS_BUSINESS_VERIFY_API_KEY가 설정되지 않았습니다.",
    };
  }

  const url = `${NTS_VALIDATE_ENDPOINT}?serviceKey=${encodeURIComponent(apiKey)}`;

  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businesses: [
          {
            // b_nm(상호)은 선택 파라미터이지만 실제로 보내면 국세청 등록 상호와
            // 한 글자라도 다를 때(플랫폼 표시용 상호명이 법인 정식 상호와 다른
            // 경우 등) valid: "02"(불일치)를 반환한다 — 실계정 테스트로 확인된
            // 오탐 원인. 신원 확인에는 사업자번호+개업일자+대표자명 3개면
            // 충분하므로(국세청 API 필수 파라미터) b_nm은 보내지 않는다.
            b_no: input.businessNumber,
            start_dt: toNtsDate(input.startDate),
            p_nm: input.representativeName,
          },
        ],
      }),
    });
  } catch {
    return { status: "error", message: "국세청 API 호출에 실패했습니다 (네트워크 오류)." };
  }

  if (!response.ok) {
    return { status: "error", message: `국세청 API 호출에 실패했습니다 (HTTP ${response.status}).` };
  }

  let body: {
    status_code?: string;
    data?: Array<{ valid?: string; valid_msg?: string }>;
  };

  try {
    body = await response.json();
  } catch {
    return { status: "error", message: "국세청 API 응답을 해석할 수 없습니다." };
  }

  if (body.status_code !== "OK") {
    return { status: "error", message: "국세청 API가 오류를 반환했습니다." };
  }

  const result = body.data?.[0];

  if (!result) {
    return { status: "not_found", message: "국세청에 등록되지 않은 사업자번호입니다." };
  }

  if (result.valid === "01") {
    return { status: "match", message: "국세청 등록 정보(대표자명·개업일자)와 일치합니다." };
  }

  return {
    status: "mismatch",
    message: result.valid_msg || "국세청 등록 정보와 일치하지 않습니다. 대표자명/개업일자를 다시 확인하세요.",
  };
}
