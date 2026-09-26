import { describe, expect, it } from "vitest";
import { isDocumentReadyToAutoClose, type AutoCloseLine } from "./auto-close";

const box = (status: string) => ({ inbound_scans: { status } });
const line = (quantity: number | null, ...statuses: string[]): AutoCloseLine => ({
  quantity,
  inbound_document_line_scans: statuses.map(box),
});

describe("isDocumentReadyToAutoClose", () => {
  it("모든 줄이 예정 수량만큼 도착했고 문제 박스가 없으면 자동 마감 대상이다", () => {
    expect(isDocumentReadyToAutoClose([line(2, "NORMAL", "NORMAL"), line(1, "NORMAL")])).toBe(true);
  });

  it("수량이 비어 있으면 1박스로 본다", () => {
    expect(isDocumentReadyToAutoClose([line(null, "NORMAL")])).toBe(true);
  });

  it("줄이 없는 전표는 대상이 아니다", () => {
    expect(isDocumentReadyToAutoClose([])).toBe(false);
  });

  it("덜 왔거나 더 많이 온 줄이 있으면 사람이 봐야 한다", () => {
    expect(isDocumentReadyToAutoClose([line(2, "NORMAL")])).toBe(false);
    expect(isDocumentReadyToAutoClose([line(1, "NORMAL", "NORMAL")])).toBe(false);
    expect(isDocumentReadyToAutoClose([line(1)])).toBe(false);
  });

  it("상품 미지정·이력 못 찾음 박스가 이어져 있으면 재고에 안 들어간 것이므로 대상이 아니다", () => {
    expect(isDocumentReadyToAutoClose([line(1, "PENDING_MAPPING")])).toBe(false);
    expect(isDocumentReadyToAutoClose([line(1, "EXCEPTION")])).toBe(false);
  });

  it("무효 처리한 박스는 세지 않는다", () => {
    expect(isDocumentReadyToAutoClose([line(1, "VOIDED", "NORMAL")])).toBe(true);
    expect(isDocumentReadyToAutoClose([line(1, "VOIDED")])).toBe(false);
  });
});
