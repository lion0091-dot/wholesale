/**
 * 비즈뿌리오(bizppurio.com) 메시징 API 클라이언트 — 카카오 알림톡 발송 전용.
 *
 * ⚠️ 실제 계정으로 호출해본 적이 없다. 공식 문서(https://biztech.gitbook.io/webapi)
 * 화면 캡처 기준으로만 작성했다 — 실제 공급사 계정 발급 후 재검증 필요:
 *   - 토큰 발급: POST /v1/token, Authorization: Basic base64(계정:비밀번호)
 *     응답 { accesstoken, type: "Bearer", expired: "yyyyMMddHHmmss" }, 24시간 유효
 *   - 발송: POST /v3/message, Authorization: Bearer {accesstoken}
 *     응답 { code, description, refkey, messagekey } — code 1000은 "API 호출 성공"일 뿐
 *     실제 발송(수신) 성공을 뜻하지 않는다. 발송 결과 조회(리포트 API)는 별도 과제로 남겨둠.
 *
 * 매 발송마다 토큰을 새로 발급받는다(캐싱 없음) — 서버리스 환경이라 프로세스 간 캐시를
 * 공유하기 어렵고, 이 서비스는 발송 빈도가 낮아(주문 알림 등) 매번 재발급해도 API 호출
 * 한도에 크게 영향 없을 것으로 판단. 발송량이 늘면 토큰을 DB에 캐싱하는 최적화 고려.
 */

const TOKEN_ENDPOINT = "https://api.bizppurio.com/v1/token";
const MESSAGE_ENDPOINT = "https://api.bizppurio.com/v3/message";

export class BizppurioError extends Error {}

interface TokenResponse {
  accesstoken?: string;
  type?: string;
  expired?: string;
}

async function fetchAccessToken(account: string, password: string): Promise<string> {
  const basic = Buffer.from(`${account}:${password}`, "utf8").toString("base64");

  let response: Response;

  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-type": "application/json; charset=utf-8",
      },
    });
  } catch {
    throw new BizppurioError("비즈뿌리오 토큰 발급에 실패했습니다 (네트워크 오류).");
  }

  if (!response.ok) {
    throw new BizppurioError(
      `비즈뿌리오 토큰 발급에 실패했습니다 (HTTP ${response.status}). 계정/비밀번호를 확인해주세요.`
    );
  }

  let body: TokenResponse;

  try {
    body = await response.json();
  } catch {
    throw new BizppurioError("비즈뿌리오 토큰 응답을 해석할 수 없습니다.");
  }

  if (!body.accesstoken) {
    throw new BizppurioError("비즈뿌리오 토큰 응답에 accesstoken이 없습니다.");
  }

  return body.accesstoken;
}

export interface SendAlimtalkParams {
  account: string;
  password: string;
  /** 카카오톡 비즈메시지 발신프로필키 */
  senderKey: string;
  /** 발신번호 (알림톡 실패 시 대체발송 등에도 쓰일 수 있음) */
  from: string;
  /** 수신번호 */
  to: string;
  /** 승인된 알림톡 템플릿 코드 */
  templateCode: string;
  /** 승인받은 템플릿과 동일한 형식(변수 치환 완료)이어야 카카오 서버 검증을 통과한다 */
  message: string;
  /** 재전송 방지/추적용 참조키 */
  refkey: string;
}

export interface SendAlimtalkResult {
  /** API 호출 자체의 성공 여부(code 1000). 실제 수신 성공을 보장하지 않는다. */
  accepted: boolean;
  code: number | null;
  description: string | null;
  messagekey: string | null;
}

export async function sendAlimtalk(params: SendAlimtalkParams): Promise<SendAlimtalkResult> {
  const accesstoken = await fetchAccessToken(params.account, params.password);

  let response: Response;

  try {
    response = await fetch(MESSAGE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accesstoken}`,
        "Content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        account: params.account,
        type: "at",
        from: params.from,
        to: params.to,
        refkey: params.refkey,
        content: {
          senderkey: params.senderKey,
          templatecode: params.templateCode,
          message: params.message,
        },
      }),
    });
  } catch {
    throw new BizppurioError("비즈뿌리오 발송 요청에 실패했습니다 (네트워크 오류).");
  }

  if (!response.ok) {
    throw new BizppurioError(`비즈뿌리오 발송 요청에 실패했습니다 (HTTP ${response.status}).`);
  }

  let body: { code?: number; description?: string; messagekey?: string };

  try {
    body = await response.json();
  } catch {
    throw new BizppurioError("비즈뿌리오 발송 응답을 해석할 수 없습니다.");
  }

  return {
    accepted: body.code === 1000,
    code: body.code ?? null,
    description: body.description ?? null,
    messagekey: body.messagekey ?? null,
  };
}
