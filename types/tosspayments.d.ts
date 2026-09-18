/**
 * 토스페이먼츠 결제창(v1) 브라우저 SDK — 공식 타입 패키지가 없어 우리가 쓰는
 * 표면만 최소 선언한다. <script src="https://js.tosspayments.com/v1/payment">로
 * 로드되면 window.TossPayments 전역 함수가 생긴다.
 */
export interface TossRequestPaymentParams {
  amount: number;
  orderId: string;
  orderName: string;
  customerName?: string;
  successUrl: string;
  failUrl: string;
}

export interface TossPaymentsInstance {
  requestPayment(method: "카드", params: TossRequestPaymentParams): Promise<void>;
}

declare global {
  interface Window {
    TossPayments?: (clientKey: string) => TossPaymentsInstance;
  }
}
