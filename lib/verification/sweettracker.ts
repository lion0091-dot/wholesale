/**
 * 스위트트래커(SweetTracker) 배송 조회 API 클라이언트.
 *
 * 우리 플랫폼은 운송장 발급/배송비 정산을 대행하지 않는다 — 공급사가 택배사와
 * 직접 계약해 이미 발송한 운송장번호를 입력하면, 그 번호로 실시간 배송 상태만
 * 조회해서 보여주는 순수 조회 기능이다.
 *
 * ⚠️ 이 파일 작성 시점에는 실제 API 키가 없어 요청/응답 형식을 문서 기준으로만
 * 작성했다. 키가 발급되면 반드시 공식 문서(https://tracking.sweettracker.co.kr)
 * 기준으로 엔드포인트/파라미터명/응답 필드명을 재검증할 것.
 */

const SWEETTRACKER_ENDPOINT = "http://info.sweettracker.co.kr/api/v1/trackingInfo";

/**
 * 자주 쓰이는 택배사 코드 — 스위트트래커 공식 코드표 기준(재검증 필요, 위 경고 참고).
 * 목록에 없는 택배사는 지원 대상이 추가되면 여기에 추가한다.
 */
export const KOREAN_COURIERS: Array<{ code: string; label: string }> = [
  { code: "04", label: "CJ대한통운" },
  { code: "05", label: "한진택배" },
  { code: "08", label: "롯데택배" },
  { code: "06", label: "로젠택배" },
  { code: "01", label: "우체국택배" },
  { code: "23", label: "경동택배" },
];

export function courierLabel(courierCode: string | null | undefined): string {
  return KOREAN_COURIERS.find((c) => c.code === courierCode)?.label ?? "택배사 미확인";
}

export type TrackingLookupStatus = "ok" | "not_configured" | "error";

export interface TrackingEvent {
  time: string;
  location: string;
  status: string;
}

export interface TrackingResult {
  status: TrackingLookupStatus;
  message: string;
  /** 배송 완료 여부 (조회 성공 시에만 의미 있음) */
  complete?: boolean;
  events?: TrackingEvent[];
}

/** SWEETTRACKER_API_KEY 설정 여부 — 미설정이면 조회 기능을 UI에서 잠근다. */
export function isSweetTrackerConfigured(): boolean {
  return Boolean(process.env.SWEETTRACKER_API_KEY);
}

/** 배송 조회 1건 호출. 네트워크/API 오류는 던지지 않고 status: "error"로 반환한다. */
export async function fetchTrackingStatus(
  courierCode: string,
  trackingNumber: string
): Promise<TrackingResult> {
  const apiKey = process.env.SWEETTRACKER_API_KEY;

  if (!apiKey) {
    return {
      status: "not_configured",
      message: "SWEETTRACKER_API_KEY가 설정되지 않아 배송 조회를 사용할 수 없습니다.",
    };
  }

  const url = `${SWEETTRACKER_ENDPOINT}?t_key=${encodeURIComponent(apiKey)}&t_code=${encodeURIComponent(
    courierCode
  )}&t_invoice=${encodeURIComponent(trackingNumber)}`;

  let response: Response;

  try {
    response = await fetch(url, { method: "GET" });
  } catch {
    return { status: "error", message: "배송 조회 API 호출에 실패했습니다 (네트워크 오류)." };
  }

  if (!response.ok) {
    return { status: "error", message: `배송 조회 API 호출에 실패했습니다 (HTTP ${response.status}).` };
  }

  let body: {
    status?: boolean;
    msg?: string;
    complete?: boolean;
    trackingDetails?: Array<{ time?: string; where?: string; kind?: string }>;
  };

  try {
    body = await response.json();
  } catch {
    return { status: "error", message: "배송 조회 API 응답을 해석할 수 없습니다." };
  }

  if (body.status === false) {
    return { status: "error", message: body.msg || "배송 조회에 실패했습니다. 운송장번호를 확인해주세요." };
  }

  const events: TrackingEvent[] = (body.trackingDetails ?? []).map((detail) => ({
    time: detail.time ?? "",
    location: detail.where ?? "",
    status: detail.kind ?? "",
  }));

  return {
    status: "ok",
    message: body.complete ? "배송이 완료되었습니다." : "배송이 진행 중입니다.",
    complete: Boolean(body.complete),
    events,
  };
}
