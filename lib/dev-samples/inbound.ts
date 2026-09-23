/**
 * 개발용 미리보기 — 입고 화면의 "샘플 보기" 패널 데이터.
 *
 * 실제 API·DB를 안 건드리고, 5가지 이력번호 유형이 화면에서 어떻게 보이는지
 * 확인하려고 만들었다. 오픈 전에는 지워야 하는 개발 도구다 —
 * 폐기할 때는 이 파일 전체(`lib/dev-samples/` 폴더)를 지우고,
 * `app/dashboard/inbound/inbound-scan-view.tsx`에서 이 모듈을 가져다 쓰는
 * 부분(패널 렌더링 + addSampleRow/removeSampleRow/clearSampleRows)만 지우면 된다.
 */
import type { InboundScanRow } from "@/app/dashboard/inbound/inbound-scan-view";
import { buildScanRequirementReport, type ScanFacts } from "@/lib/livestock/inbound-requirements";

export interface InboundSampleKind {
  label: string;
  traceNo: string;
  weight: number;
  status: InboundScanRow["status"];
  productName: string | null;
  note: string;
  /**
   * 체크리스트(ScanRequirementList)까지 같이 보여주고 싶을 때만 채운다 —
   * 실제 화면은 이력조회·명세서를 서버에서 붙여 이 값을 만들지만(29단계 B),
   * 샘플은 서버를 안 타므로 같은 함수(buildScanRequirementReport)에 가짜
   * 사실관계를 직접 넣어 똑같은 결과물을 미리 만든다.
   */
  requirementFacts?: ScanFacts;
}

export const INBOUND_SAMPLE_KINDS = {
  NORMAL_INDIVIDUAL: {
    label: "① 일반 개체 (API 확인됨)",
    traceNo: "002191840078",
    weight: 8.2,
    status: "NORMAL",
    productName: "한우 등심 1++",
    note: "정부 이력제 API로 바로 조회된 정상 케이스입니다.",
  },
  NORMAL_GROUP: {
    label: "② 정부 발행 묶음 (API 확인됨)",
    traceNo: "L01234567890123",
    weight: 15.0,
    status: "NORMAL",
    productName: "한우 갈비 1+",
    note: "여러 마리를 묶은 정부 발행 묶음번호 — 개체번호와 같은 API로 조회됩니다.",
  },
  SUPPLIER_BUNDLE: {
    label: "③ 공급자 자체 묶음 (API에 없음)",
    traceNo: "SUPP-LOT-0913-A",
    weight: 5.0,
    status: "EXCEPTION",
    productName: null,
    note: "정부 API에 없는 공급자 자체 코드 — 상품을 직접 지정해야 재고에 반영됩니다.",
  },
  ORDER_BUNDLE: {
    label: "④ 고객주문용 공급자 묶음 (API에 없음, 주문 배정 대상)",
    traceNo: "SUPP-ORD-2603-01",
    weight: 3.0,
    status: "EXCEPTION",
    productName: null,
    note: "고객 주문 때문에 공급자가 특별히 만들어 온 묶음 — \"주문에 바로 배정\" 기능의 대상입니다.",
  },
  GRADE_ORIGIN_MISMATCH: {
    label: "⑤ 원산지·등급 불일치 (이력조회 vs 명세서)",
    traceNo: "002199912345",
    weight: 6.4,
    status: "NORMAL",
    productName: "소고기 척아이 1+",
    note: "이력조회 결과와 올라온 명세서의 등급·원산지가 서로 다른 경우 — 체크리스트에 충돌 경고가 뜹니다.",
    requirementFacts: {
      traceNo: "002199912345",
      productId: "sample-product",
      productName: "소고기 척아이 1+",
      productOrigin: "호주산",
      weight: 6.4,
      labeledWeight: 6.5,
      purchaseUnitPrice: 18000,
      purchaseSupplier: "성진축산",
      traceFound: true,
      apiGrade: "1++",
      apiOrigin: "국내산",
      documentMatched: true,
      documentSupplier: "성진축산",
      documentGrade: "1+",
      documentOrigin: "호주산",
      documentUnitPrice: 18000,
      documentLabeledWeight: 6.5,
    },
  },
} satisfies Record<string, InboundSampleKind>;

export type InboundSampleKey = keyof typeof INBOUND_SAMPLE_KINDS;

/** 선택한 유형 하나를 실제 InboundScanRow 모양으로 만든다. */
export function buildSampleInboundRow(kind: InboundSampleKey): InboundScanRow {
  const sample: InboundSampleKind = INBOUND_SAMPLE_KINDS[kind];

  return {
    id: `sample-${kind}-${Date.now()}`,
    traceNo: sample.traceNo,
    productId: null,
    productName: sample.productName,
    weight: sample.weight,
    unit: "kg",
    scanType: "MANUAL",
    status: sample.status,
    remainingWeight: sample.status === "NORMAL" ? sample.weight : 0,
    createdAt: new Date().toISOString(),
    labeledWeight: null,
    weightVariance: null,
    purchaseUnitPrice: null,
    purchaseAmount: null,
    purchaseSupplier: null,
    scannedByName: "샘플",
    storageLocation: null,
    storageLocationPhotoPath: null,
    isSample: true,
    sampleNote: sample.note,
    sampleRequirementReport: sample.requirementFacts
      ? buildScanRequirementReport(sample.requirementFacts)
      : undefined,
  };
}
