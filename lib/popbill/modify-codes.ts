/**
 * 국세청 표준 수정사유 코드. 순수 데이터만 담은 파일이다 — lib/popbill/client.ts(팝빌
 * SDK, Node 전용 fs/child_process 의존)를 import하지 않아야 클라이언트 컴포넌트
 * (tax-invoice-draft-panel.tsx)에서 안전하게 쓸 수 있다.
 */
export type ModifyCode = 1 | 2 | 3 | 4 | 5 | 6;

export const MODIFY_CODE_LABELS: Record<ModifyCode, string> = {
  1: "기재사항 착오정정",
  2: "공급가액 변동",
  3: "환입",
  4: "계약해제",
  5: "내국신용장 사후개설",
  6: "착오에 의한 이중발행",
};
