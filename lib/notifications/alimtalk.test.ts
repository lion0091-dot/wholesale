import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const credentialRow: { current: Record<string, unknown> | null } = { current: null };

vi.mock("@/lib/supabase/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: credentialRow.current }),
        }),
      }),
    }),
  }),
}));

import { encryptCredential } from "@/lib/security/credential-crypto";
import {
  sendOrderNotificationToWholesaler,
  sendReceivablesReminderToRetailer,
  type OrderNotificationPayload,
} from "@/lib/notifications/alimtalk";

const WHOLESALER_ID = "11111111-1111-1111-1111-111111111111";

function orderPayload(overrides: Partial<OrderNotificationPayload> = {}): OrderNotificationPayload {
  return {
    wholesalerId: WHOLESALER_ID,
    wholesalerName: "A축산",
    wholesalerPhone: "01012345678",
    restaurantName: "식당R",
    orderNumber: "ORD-1",
    itemsSummary: "한우 등심 1kg",
    totalAmount: 68000,
    deliveryAddress: "서울",
    ...overrides,
  };
}

function readyRow(overrides: Record<string, unknown> = {}) {
  return {
    alimtalk_account: "acct-a",
    alimtalk_password_encrypted: encryptCredential("pw-plain"),
    alimtalk_sender_key: "senderkey-a",
    alimtalk_sender_phone: "0212345678",
    alimtalk_template_codes: { orderNew: "TPL_ORDER", receivablesReminder: "TPL_REMIND" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
  credentialRow.current = null;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockTokenThenSend(sendResponse: Response | Error) {
  fetchMock.mockResolvedValueOnce(jsonResponse({ accesstoken: "TOKEN", type: "Bearer", expired: "20990101000000" }));

  if (sendResponse instanceof Error) {
    fetchMock.mockRejectedValueOnce(sendResponse);
  } else {
    fetchMock.mockResolvedValueOnce(sendResponse);
  }
}

describe("미설정은 정상 상태(not_configured) — 발송 시도 자체를 안 한다", () => {
  it("wholesalerId가 null(데모/미연결 주문)", async () => {
    const result = await sendOrderNotificationToWholesaler(orderPayload({ wholesalerId: null }));

    expect(result).toMatchObject({ success: false, status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("수신 번호가 없다", async () => {
    credentialRow.current = readyRow();

    const result = await sendOrderNotificationToWholesaler(orderPayload({ wholesalerPhone: undefined }));

    expect(result).toMatchObject({ success: false, status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("자격정보 행이 없다", async () => {
    credentialRow.current = null;

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: false, status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["alimtalk_account", null],
    ["alimtalk_password_encrypted", null],
    ["alimtalk_sender_key", ""],
    ["alimtalk_sender_phone", null],
  ])("필수 컬럼 %s가 비어 있다", async (column, emptyValue) => {
    credentialRow.current = readyRow({ [column]: emptyValue });

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: false, status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("이 알림의 템플릿 코드만 없다 — 안내 문구가 붙는다", async () => {
    credentialRow.current = readyRow({ alimtalk_template_codes: { receivablesReminder: "TPL_REMIND" } });

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result.status).toBe("not_configured");
    expect(result.error).toContain("템플릿 코드가 아직 등록되지 않았습니다");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("템플릿 코드 컬럼이 null이어도 죽지 않는다", async () => {
    credentialRow.current = readyRow({ alimtalk_template_codes: null });

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result.status).toBe("not_configured");
  });
});

describe("복호화 실패는 error로 구분하고 로그를 남긴다", () => {
  it("저장된 값이 깨졌다", async () => {
    credentialRow.current = readyRow({ alimtalk_password_encrypted: "not-a-valid-cipher" });

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: false, status: "error" });
    expect(result.error).toContain("다시 등록");
    expect(console.error).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("암호화 키가 바뀌었다(키 분실 상황)", async () => {
    credentialRow.current = readyRow();
    process.env.CREDENTIAL_ENCRYPTION_KEY = "cd".repeat(32);

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: false, status: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("암호화 키가 아예 없다", async () => {
    credentialRow.current = readyRow();
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: false, status: "error" });
  });
});

describe("정상 발송", () => {
  it("code 1000이면 sent — 토큰 발급 뒤 올바른 본문으로 발송한다", async () => {
    credentialRow.current = readyRow();
    mockTokenThenSend(jsonResponse({ code: 1000, description: "OK", refkey: "x", messagekey: "m-1" }));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: true, status: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://api.bizppurio.com/v1/token");
    expect(tokenInit.headers.Authorization).toBe(`Basic ${Buffer.from("acct-a:pw-plain").toString("base64")}`);

    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toBe("https://api.bizppurio.com/v3/message");
    expect(sendInit.headers.Authorization).toBe("Bearer TOKEN");

    const body = JSON.parse(sendInit.body);
    expect(body).toMatchObject({
      account: "acct-a",
      type: "at",
      from: "0212345678",
      to: "01012345678",
      content: { senderkey: "senderkey-a", templatecode: "TPL_ORDER" },
    });
    expect(body.refkey).toMatch(/^ALIM-/);
    expect(body.content.message).toContain("ORD-1");
  });

  it("거래처 대상 알림은 그 알림의 템플릿 코드를 쓴다", async () => {
    credentialRow.current = readyRow();
    mockTokenThenSend(jsonResponse({ code: 1000 }));

    const result = await sendReceivablesReminderToRetailer({
      wholesalerId: WHOLESALER_ID,
      wholesalerName: "A축산",
      retailerName: "식당R",
      retailerPhone: "01099998888",
      outstandingBalance: 150000,
      nearestDueAt: "2026-09-30T00:00:00.000Z",
      isOverdue: false,
    });

    expect(result.status).toBe("sent");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      to: "01099998888",
      content: { templatecode: "TPL_REMIND" },
    });
  });
});

describe("비즈뿌리오 오류", () => {
  beforeEach(() => {
    credentialRow.current = readyRow();
  });

  it("비밀번호 오류로 토큰 발급이 401 — 계정/비밀번호 확인 안내", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: false, status: "error" });
    expect(result.error).toContain("토큰 발급에 실패");
    expect(result.error).toContain("401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("토큰 응답에 accesstoken이 없다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ type: "Bearer" }));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result.status).toBe("error");
    expect(result.error).toContain("accesstoken");
  });

  it("토큰 발급 중 네트워크 예외", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result.status).toBe("error");
    expect(result.error).toContain("네트워크");
  });

  it("발송 요청이 HTTP 500", async () => {
    mockTokenThenSend(jsonResponse({}, 500));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: false, status: "error" });
    expect(result.error).toContain("HTTP 500");
  });

  it("발송 중 네트워크 예외", async () => {
    mockTokenThenSend(new TypeError("fetch failed"));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result.status).toBe("error");
    expect(result.error).toContain("네트워크");
  });

  it("발송 응답이 JSON이 아니다", async () => {
    mockTokenThenSend(new Response("<html>gateway</html>", { status: 200 }));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result.status).toBe("error");
    expect(result.error).toContain("해석할 수 없습니다");
  });

  it("code 7315(템플릿 없음/미승인)는 한국어 안내 + 코드", async () => {
    mockTokenThenSend(jsonResponse({ code: 7315, description: "Template not found" }));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: false, status: "error" });
    expect(result.error).toContain("템플릿 코드가 잘못됐거나 아직 카카오 승인");
    expect(result.error).toContain("7315");
  });

  it("code 7204(문구 불일치)도 한국어 안내", async () => {
    mockTokenThenSend(jsonResponse({ code: 7204, description: "Message mismatch" }));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result.error).toContain("승인받은 템플릿과 다릅니다");
  });

  it("목록에 없는 코드는 원문 description + 코드", async () => {
    mockTokenThenSend(jsonResponse({ code: 9999, description: "Unknown failure" }));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result.error).toBe("Unknown failure (코드 9999)");
  });

  it("코드도 description도 없으면 일반 문구", async () => {
    mockTokenThenSend(jsonResponse({}));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    expect(result).toMatchObject({ success: false, status: "error" });
    expect(result.error).toBe("비즈뿌리오가 발송을 거부했습니다.");
  });

  it("오류 응답과 로그 어디에도 비밀번호 원문이 없다", async () => {
    mockTokenThenSend(jsonResponse({}, 500));

    const result = await sendOrderNotificationToWholesaler(orderPayload());

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(JSON.stringify(result)).not.toContain("pw-plain");
    expect(logged).not.toContain("pw-plain");
  });
});

describe("전화번호 형식 — 정규화 없이 받은 값을 그대로 `to`에 보낸다 (현재 동작 기록)", () => {
  it.each([
    ["010-1234-5678"],
    ["010 1234 5678"],
    ["+82 10-1234-5678"],
    ["01012345678"],
  ])("%s → to에 원문 그대로", async (phone) => {
    credentialRow.current = readyRow();
    mockTokenThenSend(jsonResponse({ code: 1000 }));

    await sendOrderNotificationToWholesaler(orderPayload({ wholesalerPhone: phone }));

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).to).toBe(phone);
  });

  it("빈 문자열은 수신 번호 없음으로 취급 — 발송하지 않는다", async () => {
    credentialRow.current = readyRow();

    const result = await sendOrderNotificationToWholesaler(orderPayload({ wholesalerPhone: "" }));

    expect(result.status).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("공백만 있는 번호는 빈 값으로 걸러지지 않고 그대로 발송을 시도한다 (관찰)", async () => {
    credentialRow.current = readyRow();
    mockTokenThenSend(jsonResponse({ code: 3000, description: "invalid receiver" }));

    const result = await sendOrderNotificationToWholesaler(orderPayload({ wholesalerPhone: "   " }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("error");
  });
});
