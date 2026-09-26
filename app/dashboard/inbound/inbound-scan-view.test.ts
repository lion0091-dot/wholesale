import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("./actions", () => ({
  recordScanAction: async () => ({ success: true }),
  recordSplitScansAction: async () => ({ success: true }),
  resolveMappingAction: async () => ({ success: true }),
  resolveMappingToOrderAction: async () => ({ success: true }),
  voidScanAction: async () => ({ success: true }),
  setScanStorageLocationAction: async () => ({ success: true }),
  getScanLocationPhotoUrlAction: async () => ({ success: true }),
}));
vi.mock("./document-actions", () => ({ setDocumentsScanFinishedAction: async () => ({ success: true }) }));
vi.mock("./trace-no-fixer", () => ({ TraceNoFixer: () => null }));

import { InboundScanView, type InboundScanRow } from "./inbound-scan-view";

const row = (id: string, status: InboundScanRow["status"], traceNo: string): InboundScanRow => ({
  id,
  traceNo,
  productId: status === "NORMAL" ? "p1" : null,
  productName: status === "NORMAL" ? "등심" : null,
  weight: 5,
  unit: "kg",
  scanType: "BARCODE_SCAN",
  status,
  remainingWeight: status === "NORMAL" ? 5 : 0,
  createdAt: "2026-09-26T01:00:00.000Z",
  labeledWeight: null,
  weightVariance: null,
  purchaseUnitPrice: null,
  purchaseAmount: null,
  purchaseSupplier: null,
  scannedByName: null,
  storageLocation: null,
  storageLocationPhotoPath: null,
});

const render = (scans: InboundScanRow[], products: Array<{ id: string; name: string; category: string; subcategory: string | null; grade: string | null; origin: string | null; unit: string; is_active?: boolean }> = []) =>
  renderToStaticMarkup(
    createElement(InboundScanView, {
      initialScans: scans,
      scanDocuments: [],
      remainingBoxCount: 0,
      remainingWeightLines: 0,
      products,
      shippableOrders: [],
      scanRequirements: {},
      pendingDocumentTraceNos: [],
      awaitingDocumentLines: [],
      storageLocationSuggestions: [],
      canEditPurchasePrice: true,
    })
  );

describe("입고 스캔 화면 구조 — 스캔과 입고 처리에 집중한다", () => {
  const scans = [row("ok-1", "NORMAL", "000000000001"), row("bad-1", "EXCEPTION", "000000000002"), row("map-1", "PENDING_MAPPING", "000000000003")];

  it("확인이 필요한 박스는 위쪽 별도 자리에 항상 보이고, 정상 박스가 든 입고 내역은 접혀 있다", () => {
    const html = render(scans);

    expect(html).toContain('id="inbound-unresolved"');
    expect(html).toContain("확인이 필요한 박스 2개");
    expect(html).toContain('id="scan-bad-1"');
    expect(html).toContain('id="scan-map-1"');
    expect(html).not.toContain('id="scan-ok-1"');
    expect(html).toContain('id="inbound-history"');
    expect(html).toContain("열기 ▼");
    expect(html).toContain("지금까지 찍은 박스 1건");
  });

  it("확인이 필요한 박스가 없으면 그 자리는 그려지지 않는다", () => {
    const html = render([row("ok-1", "NORMAL", "000000000001")]);

    expect(html).not.toContain('id="inbound-unresolved"');
    expect(html).toContain('id="inbound-history"');
  });

  it("같은 박스가 두 자리에 겹쳐 그려지지 않는다(박스 행 id가 화면에 한 번만 있다)", () => {
    const html = render(scans);
    const ids = [...html.matchAll(/id="scan-([^"]+)"/g)].map((match) => match[1]);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("상품이 하나도 없으면 상품 선택 대신 상품 등록 안내 링크가 나오고, 있으면 판매중지 상품도 '· 판매중지'로 표시해 고를 수 있다", () => {
    expect(render(scans, [])).toContain("지정할 상품이 없습니다");

    const html = render(scans, [{ id: "p9", name: "자동생성상품", category: "소", subcategory: "등심", grade: null, origin: null, unit: "kg", is_active: false }]);

    expect(html).not.toContain("지정할 상품이 없습니다");
    expect(html).toContain("· 판매중지");
  });
});
