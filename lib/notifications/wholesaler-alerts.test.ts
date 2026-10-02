import { beforeEach, describe, expect, it, vi } from "vitest";

const sendOrder = vi.fn();
const isFallbackEnabled = vi.fn();
const sendPush = vi.fn();

vi.mock("@/lib/notifications/alimtalk", () => ({
  isAlimtalkFallbackEnabled: (...args: unknown[]) => isFallbackEnabled(...args),
  sendOrderNotificationToWholesaler: (...args: unknown[]) => sendOrder(...args),
  sendOrderEditedNotificationToWholesaler: vi.fn(),
  sendCancelRequestNotificationToWholesaler: vi.fn(),
  sendCreditLimitExceededNotificationToWholesaler: vi.fn(),
}));

vi.mock("@/lib/notifications/web-push", () => ({
  sendWholesalerPush: (...args: unknown[]) => sendPush(...args),
}));

import { notifyWholesalerNewOrder } from "./wholesaler-alerts";

const payload = {
  wholesalerId: "w1",
  orderNumber: "ORD-1",
  retailerName: "맛있는식당",
  totalAmount: 100000,
  itemCount: 2,
  deliveryAddress: "서울",
  orderedAt: new Date().toISOString(),
} as unknown as Parameters<typeof notifyWholesalerNewOrder>[0];

const ALIM_RESULT = { success: true, status: "sent", messageId: "ALIM-1", sentAt: "", templateTitle: "", formattedMessage: "" };

describe("notifyWholesalerNewOrder 채널 선택", () => {
  beforeEach(() => {
    sendOrder.mockReset().mockResolvedValue(ALIM_RESULT);
    isFallbackEnabled.mockReset().mockResolvedValue(true);
    sendPush.mockReset();
  });

  it("푸시를 받은 기기가 있으면 알림톡은 보내지 않고 폴백 설정도 묻지 않는다", async () => {
    sendPush.mockResolvedValue({ accepted: 1 });

    const result = await notifyWholesalerNewOrder(payload);

    expect(result.messageId.startsWith("PUSH-")).toBe(true);
    expect(sendOrder).not.toHaveBeenCalled();
    expect(isFallbackEnabled).not.toHaveBeenCalled();
  });

  it("푸시를 아무도 못 받고 폴백이 켜져 있으면 알림톡으로 간다(기본)", async () => {
    sendPush.mockResolvedValue({ accepted: 0 });

    const result = await notifyWholesalerNewOrder(payload);

    expect(result.messageId).toBe("ALIM-1");
    expect(sendOrder).toHaveBeenCalledTimes(1);
  });

  it("푸시를 아무도 못 받아도 폴백을 끈 업체는 알림톡을 보내지 않는다", async () => {
    sendPush.mockResolvedValue({ accepted: 0 });
    isFallbackEnabled.mockResolvedValue(false);

    const result = await notifyWholesalerNewOrder(payload);

    expect(sendOrder).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.status).toBe("not_configured");
    expect(result.messageId.startsWith("SKIP-")).toBe(true);
  });

  it("업체 id가 없으면 푸시를 시도하지 않고 알림톡 경로로 간다(기존 동작)", async () => {
    const result = await notifyWholesalerNewOrder({ ...payload, wholesalerId: null } as unknown as typeof payload);

    expect(sendPush).not.toHaveBeenCalled();
    expect(result.messageId).toBe("ALIM-1");
  });
});
