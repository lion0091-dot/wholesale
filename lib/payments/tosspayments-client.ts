/**
 * 토스페이먼츠(tosspayments.com) 결제 API 클라이언트 — 결제 승인/취소(환불) 전용.
 *
 * 알림톡(비즈뿌리오)과 같은 이유로 SDK가 아니라 raw fetch로 직접 구현했다 — 토스
 * REST API는 시크릿키 Basic Auth(비밀번호 없이 시크릿키만 base64 인코딩)로 인증이
 * 단순해서 굳이 SDK 의존성을 추가할 필요가 없다(팝빌처럼 비공개 서명 프로토콜이 있는
 * 경우와 다름).
 *
 * ⚠️ 실제 계정으로 호출해본 적이 없다. 공식 문서(https://docs.tosspayments.com)
 * 기준으로만 작성했다 — 실제 공급사 계정 발급 후 재검증 필요.
 */

const CONFIRM_ENDPOINT = "https://api.tosspayments.com/v1/payments/confirm";
const CANCEL_ENDPOINT = (paymentKey: string) =>
  `https://api.tosspayments.com/v1/payments/${encodeURIComponent(paymentKey)}/cancel`;

export class TossPaymentsError extends Error {
  code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

function basicAuthHeader(secretKey: string): string {
  return `Basic ${Buffer.from(`${secretKey}:`, "utf8").toString("base64")}`;
}

async function parseErrorBody(response: Response): Promise<{ code: string | null; message: string }> {
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    return { code: body.code ?? null, message: body.message ?? `HTTP ${response.status}` };
  } catch {
    return { code: null, message: `HTTP ${response.status}` };
  }
}

export interface ConfirmPaymentParams {
  secretKey: string;
  paymentKey: string;
  orderId: string;
  /** 원 단위 정수. 클라이언트가 넘긴 값이 아니라 서버가 계산한 기대 금액이어야 한다(변조 방지). */
  amount: number;
}

export interface TossPaymentResult {
  paymentKey: string;
  orderId: string;
  status: string;
  totalAmount: number;
  approvedAt: string | null;
}

/**
 * 결제 승인. successUrl로 리다이렉트된 뒤 10분 안에 호출해야 결제가 최종 완료된다
 * (토스 공식 문서 — 승인 API를 호출하지 않으면 결제수단에서 돈만 묶여있다가 자동 취소됨).
 */
export async function confirmPayment(params: ConfirmPaymentParams): Promise<TossPaymentResult> {
  let response: Response;

  try {
    response = await fetch(CONFIRM_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(params.secretKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentKey: params.paymentKey,
        orderId: params.orderId,
        amount: params.amount,
      }),
    });
  } catch {
    throw new TossPaymentsError("결제 승인 요청에 실패했습니다 (네트워크 오류).");
  }

  if (!response.ok) {
    const { code, message } = await parseErrorBody(response);
    throw new TossPaymentsError(message, code);
  }

  const body = (await response.json()) as {
    paymentKey: string;
    orderId: string;
    status: string;
    totalAmount: number;
    approvedAt?: string;
  };

  return {
    paymentKey: body.paymentKey,
    orderId: body.orderId,
    status: body.status,
    totalAmount: body.totalAmount,
    approvedAt: body.approvedAt ?? null,
  };
}

export interface CancelPaymentParams {
  secretKey: string;
  paymentKey: string;
  cancelReason: string;
}

/** 결제 취소(전액 환불). cancelAmount를 생략하면 토스가 전액 취소로 처리한다. */
export async function cancelPayment(params: CancelPaymentParams): Promise<TossPaymentResult> {
  let response: Response;

  try {
    response = await fetch(CANCEL_ENDPOINT(params.paymentKey), {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(params.secretKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cancelReason: params.cancelReason }),
    });
  } catch {
    throw new TossPaymentsError("결제 취소(환불) 요청에 실패했습니다 (네트워크 오류).");
  }

  if (!response.ok) {
    const { code, message } = await parseErrorBody(response);
    throw new TossPaymentsError(message, code);
  }

  const body = (await response.json()) as {
    paymentKey: string;
    orderId: string;
    status: string;
    totalAmount: number;
    approvedAt?: string;
  };

  return {
    paymentKey: body.paymentKey,
    orderId: body.orderId,
    status: body.status,
    totalAmount: body.totalAmount,
    approvedAt: body.approvedAt ?? null,
  };
}
