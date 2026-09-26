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

const render = (scans: InboundScanRow[], products: Array<{ id: string; name: string; category: string; subcategory: string | null; grade: string | null; origin: string | null; unit: string; is_active?: boolean }> = [], archivedProductCount = 0, scanRequirements: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(InboundScanView, {
      initialScans: scans,
      scanDocuments: [],
      remainingBoxCount: 0,
      remainingWeightLines: 0,
      products,
      shippableOrders: [],
      scanRequirements: scanRequirements as never,
      pendingDocumentTraceNos: [],
      awaitingDocumentLines: [],
      storageLocationSuggestions: [],
      canEditPurchasePrice: true,
      archivedProductCount,
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

  it("상품이 없는 이유가 '보관(감춤)'이면 그 사실과 보관을 풀라는 안내를 함께 보여 준다", () => {
    const html = render(scans, [], 2);

    expect(html).toContain("보관된 상품 2개");
    expect(html).toContain("보관함");
    expect(html).toContain("복원");
  });

  it("확인이 필요한 박스 행은 칸별 대조표·위치 지정·매입 금액 없이 할 일 한 줄과 처리 버튼만 보여 준다", () => {
    const html = render([{ ...row("bad-1", "EXCEPTION", "000000000002"), purchaseAmount: 297000, purchaseUnitPrice: 15000, labeledWeight: 19.8, weightVariance: 0 }]);

    expect(html).toContain("이력을 찾지 못했습니다");
    expect(html).not.toContain("위치 지정");
    expect(html).not.toContain("매입 297,000원");
    expect(html).not.toContain("전표 품목명");
  });

  it("확인 필요 박스 행에는 (대조표 데이터가 있어도) 칸 표·필수 항목 안내가 나오지 않는다", () => {
    const report = {
      fields: [
        { key: "grade", label: "등급", value: "1+", source: "TRACE", level: "RECOMMENDED", conflict: "등급: 이력조회 1+ / 전표 1++", hint: null },
        { key: "origin", label: "원산지", value: null, source: null, level: "REQUIRED", conflict: null, hint: "원산지가 없습니다" },
      ],
      missingRequired: 1,
      conflictCount: 1,
      documentMatched: true,
    };
    const ok = row("ok-1", "NORMAL", "000000000001");
    const voided = row("void-1", "VOIDED", "000000000004");
    const reqs = { "ok-1": report, "void-1": report };
    // 입고 내역은 기본 접힘이라 서버 렌더에서 그 안의 행(정상·취소 박스의 요약)은 검증하지 못한다 — 여기서는 항상 보이는 확인 필요 박스 자리만 본다.
    const html = render([{ ...ok, status: "EXCEPTION", productId: null, productName: null }, voided], [], 0, reqs);

    expect(html).not.toContain("원산지가 없습니다");
    expect(html).not.toContain("전표 품목명");
  });
});

