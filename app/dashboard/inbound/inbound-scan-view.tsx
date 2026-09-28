"use client";

import { INBOUND_ANCHORS } from "@/lib/livestock/inbound-next-step";
import { TraceNoFixer } from "./trace-no-fixer";
import { HIGHLIGHT_BUTTON, HIGHLIGHT_FIELD, ResultCardView, StepCard, type StepCardStep } from "./step-card";
import {
  buildFailureCard,
  buildMissingInputCard,
  buildScanResultCard,
  type ResultCard,
} from "@/lib/livestock/inbound-scan-result";
import { rejectionSummary } from "@/lib/livestock/scan-purchase-order";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { composeProductDisplayName } from "@/lib/products/display-name";
import {
  recordScanAction,
  resolveMappingAction,
  resolveMappingToOrderAction,
  recordSplitScansAction,
  voidScanAction,
  setScanStorageLocationAction,
  getScanLocationPhotoUrlAction,
  type ScanType,
} from "./actions";
import { parseBarcode } from "@/lib/livestock/barcode-parser";
import type { ScanRequirementReport } from "@/lib/livestock/inbound-requirements";
import { DevSamplePanel } from "@/lib/dev-samples/DevSamplePanel";
import { INBOUND_SAMPLE_KINDS, buildSampleInboundRow, type InboundSampleKey } from "@/lib/dev-samples/inbound";
import {
  calcPurchaseAmount,
  evaluateWeightVariance,
  formatVarianceRatio,
  formatVarianceWeight,
} from "@/lib/livestock/weight-variance";
import { formatWon } from "@/lib/orders/status";

export interface ScanProductOption {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  grade: string | null;
  origin: string | null;
  unit: string;
  /** false면 판매중지(자동으로 만든 상품 등) — 입고에는 쓸 수 있고 고객에게만 안 보인다. */
  is_active?: boolean;
}

/** 확정·배송중 발주서 — "이 박스 특정 주문으로 바로 보내기"의 배정 대상 후보. */
export interface ShippableOrderOption {
  id: string;
  orderNumber: string;
  retailerName: string;
}

export interface InboundScanRow {
  id: string;
  traceNo: string;
  productId: string | null;
  productName: string | null;
  weight: number;
  unit: string;
  scanType: string;
  status: "NORMAL" | "PENDING_MAPPING" | "EXCEPTION" | "VOIDED";
  remainingWeight: number;
  createdAt: string;
  /** 바코드·라벨에 적힌 표기중량. weight는 저울에 찍힌 실중량이다. */
  labeledWeight: number | null;
  weightVariance: number | null;
  purchaseUnitPrice: number | null;
  purchaseAmount: number | null;
  purchaseSupplier: string | null;
  /** 여러 직원이 섞여서 스캔할 때 누가 찍었는지 — 없으면(탈퇴 등) null */
  scannedByName: string | null;
  /** 보관 위치(선택, 자유 텍스트) — 업체마다 창고 구조가 달라 고정 목록이 없다. */
  storageLocation: string | null;
  /** 위치 참고 사진 경로(선택). private 버킷이라 볼 때마다 서명 링크를 새로 받는다. */
  storageLocationPhotoPath: string | null;
  /**
   * 개발용 미리보기 행 — DB에 없다. 5가지 이력번호 유형이 화면에서 각각 어떻게
   * 보이는지 실제 API·DB 호출 없이 확인하려고 만들었다. 실제 동작은 하지 않으므로
   * 목록에서 이 값이 true면 상품 지정·주문 배정·취소를 전부 숨긴다.
   */
  isSample?: boolean;
  sampleNote?: string;
  /** 샘플 중 체크리스트(등급·원산지 충돌 등)까지 보여주는 것만 채운다. */
  sampleRequirementReport?: ScanRequirementReport;
}

const STATUS_BADGE: Record<InboundScanRow["status"], { label: string; bg: string; color: string }> = {
  NORMAL: { label: "입고완료", bg: "#dcfce7", color: "#166534" },
  PENDING_MAPPING: { label: "상품 확인 필요", bg: "#fef3c7", color: "#92400e" },
  EXCEPTION: { label: "이력 확인 필요", bg: "#fee2e2", color: "#991b1b" },
  VOIDED: { label: "취소됨", bg: "#f1f5f9", color: "#64748b" },
};

/**
 * 스캔 직후 서버 응답을 기다리는 동안 목록에 먼저 얹는 임시 행.
 * 현장에서는 한 박스를 찍고 바로 다음 박스로 넘어가므로, 응답을 기다리며
 * 화면이 멈춰 있으면 안 된다(낙관적 UI).
 */
interface PendingRow {
  key: string;
  traceNo: string;
  weight: number;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * 카메라로 바코드를 찍을 수 있는 환경인지. getUserMedia만 있으면 된다 —
 * 인식 자체는 BarcodeDetector(Android Chrome 등)가 있으면 그걸 쓰고,
 * 없으면(iOS Safari 등) zxing 라이브러리로 대신한다.
 */
function hasCameraScan(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

interface Props {
  initialScans: InboundScanRow[];
  /**
   * 스캔 id → 필수항목 체크리스트. 서버에서 공공조회를 붙여 만든다.
   * 방금 찍어서 아직 서버 데이터가 없는 줄은 여기 없고, 새로고침되면 채워진다.
   */
  scanRequirements: Record<string, ScanRequirementReport>;
  products: ScanProductOption[];
  shippableOrders: ShippableOrderOption[];
  /** 이 업체가 그동안 직접 입력한 위치 이름 — 고정 목록 대신 제안용으로 쓴다. */
  storageLocationSuggestions: string[];
  /** 보관(감춤)돼 목록에서 빠진 상품 수 — 지정할 상품이 없을 때 보관을 풀라고 안내한다. */
  archivedProductCount?: number;
  /** 매입단가 칸 노출 여부 — owner/manager/super_admin만 true. 직원은 칸이 없고 값도 안 보낸다. */
  canEditPurchasePrice: boolean;
  /** "지금 온 거래처"로 고를 수 있는 거래처(사용 중인 것만). 발주 관리의 거래처 관리에서 만든다. */
  suppliers: Array<{ id: string; name: string }>;
}

const SUPPLIER_STORAGE_KEY = "inbound:current-supplier";

/** 오픈 직전 Vercel에서 이 값을 지우거나 false로 바꾸면 샘플 패널이 전부 사라진다. */
const SHOW_DEV_SAMPLES = process.env.NEXT_PUBLIC_SHOW_DEV_SAMPLES === "true";

/** 값이 어디서 왔는지 한눈에 — 출처마다 색을 달리한다. */
const SOURCE_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  SCAN: { label: "스캔", bg: "#e0f2fe", fg: "#075985" },
  TRACE_API: { label: "이력조회", bg: "#dcfce7", fg: "#166534" },
  PRODUCT: { label: "상품", bg: "#f1f5f9", fg: "#475569" },
};

/**
 * 박스 옆 대조 요약 — 칸 표는 기본으로 접는다.
 * 칸 표를 늘 펼쳐 두면 박스마다 화면 반 장을 차지해 정작 볼 것이 묻힌다.
 */
function ScanRequirementSummary({ report }: { report: ScanRequirementReport }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ width: "100%", marginTop: "2px" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{ border: "none", background: "none", padding: "2px 0", color: "#2563eb", fontSize: "11px", cursor: "pointer" }}
      >
        {open ? "대조 항목 접기 ▲" : `대조 항목 보기 ▼${report.missingRequired > 0 ? ` (비어 있는 필수 ${report.missingRequired}개)` : ""}`}
      </button>
      {open ? <ScanRequirementList report={report} /> : null}
    </div>
  );
}

function ScanRequirementList({ report }: { report: ScanRequirementReport }) {
  return (
    <div style={{ width: "100%", marginTop: "4px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", alignItems: "center" }}>
        {report.fields.map((field) => {
          const source = field.source ? SOURCE_STYLE[field.source] : null;
          const missing = !field.value;
          const required = field.level === "REQUIRED";

          return (
            <span
              key={field.key}
              title={field.hint ?? undefined}
              style={{
                fontSize: "11px",
                borderRadius: "5px",
                padding: "3px 7px",
                border: "1px solid",
                ...(missing
                  ? required
                    ? { backgroundColor: "#fef2f2", color: "#991b1b", borderColor: "#fecaca" }
                    : { backgroundColor: "#fffbeb", color: "#92400e", borderColor: "#fde68a" }
                  : { backgroundColor: "#ffffff", color: "#334155", borderColor: "#e2e8f0" }),
              }}
            >
              {field.label} {missing ? "—" : field.value}
              {source ? (
                <span
                  style={{
                    marginLeft: "4px",
                    fontSize: "10px",
                    borderRadius: "3px",
                    padding: "1px 4px",
                    backgroundColor: source.bg,
                    color: source.fg,
                  }}
                >
                  {source.label}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>

      {report.fields
        .filter((field) => !field.value && field.level === "REQUIRED" && field.hint)
        .map((field) => (
          <p
            key={`hint-${field.key}`}
            style={{ margin: "3px 0 0", fontSize: "11px", color: "#991b1b" }}
          >
            {field.label}: {field.hint}
          </p>
        ))}
    </div>
  );
}

export function InboundScanView({
  initialScans,
  products,
  shippableOrders,
  scanRequirements,
  storageLocationSuggestions,
  archivedProductCount = 0,
  canEditPurchasePrice,
  suppliers,
}: Props) {
  const router = useRouter();

  // 지금 온 거래처 — 한 번 고르면 다음 박스에도 그대로 남는다(한 차 분량은 대체로 한 거래처). 새로고침해도 기억한다.
  const [supplierId, setSupplierId] = useState("");
  const supplierSelectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SUPPLIER_STORAGE_KEY);

      if (saved && suppliers.some((item) => item.id === saved)) setSupplierId(saved);
      else if (suppliers.length === 1) setSupplierId(suppliers[0].id);
    } catch {
      // 저장소를 못 쓰는 환경 — 그냥 매번 고르게 둔다.
    }
  }, [suppliers]);

  const handleSupplierChange = (value: string) => {
    setSupplierId(value);

    try {
      if (value) window.localStorage.setItem(SUPPLIER_STORAGE_KEY, value);
      else window.localStorage.removeItem(SUPPLIER_STORAGE_KEY);
    } catch {
      // 저장 실패는 화면 동작에 영향이 없다.
    }
  };

  const askSupplier = () => {
    setResultCard({ card: buildMissingInputCard("supplier"), scanId: null });
    supplierSelectRef.current?.focus();
  };

  // 상품 확인 필요/이력 확인 필요 행 중 "특정 주문으로 바로 보내기" 패널을 펼친 스캔 id.
  const [orderTargetScanId, setOrderTargetScanId] = useState<string | null>(null);
  const [orderTargetProductId, setOrderTargetProductId] = useState("");
  const [orderTargetOrderId, setOrderTargetOrderId] = useState("");
  const [resolvingToOrder, setResolvingToOrder] = useState(false);

  // 공급자가 서로 다른 상품을 한 박스·한 코드로 묶어 보낸 경우 — 코드는 하나만
  // 찍고, 실제 내용물별로 상품·무게를 나눠 입력한다("이 박스 안에 뭐가 들었는지"는
  // 코드만 봐서는 알 수 없고 사람이 박스를 열어봐야 안다 — 그래서 프론트 전용 기능
  // 이다. 백엔드는 새 개념이 필요 없다 — 같은 trace_no로 recordScanAction을 상품
  // 개수만큼 반복 호출하면 그대로 박스별 여러 행으로 쌓인다).
  const [splitMode, setSplitMode] = useState(false);
  const [splitTraceNo, setSplitTraceNo] = useState("");
  /**
   * 방금 찍었는데 이력조회가 실패한 코드. 소·돼지가 섞여 온 박스는 공급처
   * 박스 바코드밖에 없어 조회될 수가 없다 — 그 자리에서 쪼개기를 권한다.
   */
  const [splitCandidate, setSplitCandidate] = useState<string | null>(null);
  /**
   * "이 박스 쪼개기" 제안에 "아니오"(상품 1개 맞음)로 답한 이력번호들.
   * 그냥 사라지게 두면 나중에 상품을 지정할 때 "이거 확인은 한 거였나"를 알 수 없어서,
   * 상품 지정 칸 옆에 계속 눈에 띄게 남겨둔다(사장님 요청 — 강제 차단은 아니고 기록만).
   */
  const [declinedSplitTraceNos, setDeclinedSplitTraceNos] = useState<Set<string>>(new Set());
  const [splitRows, setSplitRows] = useState<Array<{ id: string; productId: string; weight: string; traceNo?: string }>>([
    { id: "split-0", productId: "", weight: "", traceNo: "" },
    { id: "split-1", productId: "", weight: "", traceNo: "" },
  ]);
  const [splitSubmitting, setSplitSubmitting] = useState(false);

  const [traceNo, setTraceNo] = useState("");
  // 저울에 찍힌 실중량. 재고·매입금액의 기준이 되는 값이다.
  const [weight, setWeight] = useState("");
  // 바코드(GS1-128)에 실려 온 표기중량. 사람이 고칠 수도 있다.
  const [labeledWeight, setLabeledWeight] = useState("");
  // 매입단가는 한 차에 들어오는 물건이 대체로 같아서 스캔 후에도 비우지 않는다.
  const [unitPrice, setUnitPrice] = useState("");
  const [rows, setRows] = useState<InboundScanRow[]>(initialScans);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 방금 등록한 박스의 결과 카드 — 다음 박스를 등록하기 전까지 남는다.
  const [resultCard, setResultCard] = useState<{ card: ResultCard; scanId: string | null } | null>(null);
  const [fieldError, setFieldError] = useState<"trace" | "weight" | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraSupported, setCameraSupported] = useState(false);

  const traceInputRef = useRef<HTMLInputElement>(null);
  const weightInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // 입고 내역은 접어 두고 필요할 때만 연다. "입고 내역" 앵커 링크(#inbound-history)를 누르거나 주소에 그 앵커가 있으면 저절로 펼친다.
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (window.location.hash === INBOUND_ANCHORS.history) setHistoryOpen(true);

    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.(`a[href="${INBOUND_ANCHORS.history}"]`);

      if (link) setHistoryOpen(true);
    };

    document.addEventListener("click", onClick);

    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    setCameraSupported(hasCameraScan());
    traceInputRef.current?.focus();
  }, []);

  useEffect(() => {
    setRows(initialScans);
  }, [initialScans]);

  const submitScan = useCallback(
    async (
      rawTraceNo: string,
      rawWeight: string,
      scanType: ScanType,
      confirmDuplicate = false,
      // 중복 확인으로 다시 부를 때는 순수 이력번호만 넘어와 바코드가 사라진다 —
      // 처음 읽은 유통기한과 표기중량을 들고 다시 들어온다.
      carriedBestBefore: string | null = null,
      carriedLabeled: number | null = null
    ) => {
      // 어느 거래처 물건인지 알아야 발주서와 맞춰 볼 수 있다 — 고르기 전에는 등록하지 않는다.
      if (!supplierId) {
        askSupplier();
        return;
      }

      // 스캐너가 보낸 값은 순수 이력번호일 수도, GS1-128 물류 바코드일 수도,
      // 소비자용 QR(URL)일 수도 있다. 한 곳에서 해석해 이력번호를 뽑는다.
      const parsed = parseBarcode(rawTraceNo);
      const value = parsed.traceNo ?? rawTraceNo.trim();

      if (!value) {
        setResultCard({ card: buildMissingInputCard("trace"), scanId: null });
        setFieldError("trace");
        traceInputRef.current?.focus();
        return;
      }

      // 표기중량 — 바코드(GS1-128 AI 3103)에 실려 오거나 사람이 라벨을 보고 적는다.
      const typedLabeled = Number.parseFloat(labeledWeight);
      const labeled =
        Number.isFinite(typedLabeled) && typedLabeled > 0
          ? typedLabeled
          : carriedLabeled ?? parsed.weightKg ?? null;

      // 실중량 — 저울에 찍힌 값. 재고와 매입금액은 언제나 이 값을 쓴다.
      // 비어 있으면 표기중량을 그대로 인정한다(저울을 안 쓰는 품목도 있다).
      const typedWeight = Number.parseFloat(rawWeight);
      const parsedWeight =
        Number.isFinite(typedWeight) && typedWeight > 0 ? typedWeight : labeled ?? NaN;

      if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
        setResultCard({ card: buildMissingInputCard("weight"), scanId: null });
        setFieldError("weight");
        weightInputRef.current?.focus();
        return;
      }

      // 매입단가는 관리자(owner/manager)만 정한다 — 직원 화면은 칸 자체가 없고 값을 보내지 않는다.
      const typedPrice = canEditPurchasePrice ? Number.parseFloat(unitPrice) : Number.NaN;
      const purchaseUnitPrice = Number.isFinite(typedPrice) && typedPrice >= 0 ? typedPrice : null;

      setError(null);
      setNotice(null);
      setResultCard(null);
      setFieldError(null);

      // 낙관적 UI — 응답을 기다리지 않고 먼저 목록에 얹는다.
      const key = `${value}-${Date.now()}`;
      setPending((prev) => [{ key, traceNo: value, weight: parsedWeight }, ...prev]);

      // 다음 박스를 바로 찍을 수 있게 입력칸을 즉시 비운다.
      // 단가·거래처는 한 차 분량이 대체로 같으므로 남겨둔다.
      setTraceNo("");
      setWeight("");
      setLabeledWeight("");
      traceInputRef.current?.focus();

      const bestBefore = parsed.bestBefore ?? carriedBestBefore;

      const result = await recordScanAction({
        traceNo: value,
        weight: parsedWeight,
        scanType,
        confirmDuplicate,
        bestBefore,
        labeledWeight: labeled,
        purchaseUnitPrice,
        supplierId,
        // 바코드의 상품코드. 이력번호가 소 한 마리를 가리킨다면 이건 공급처가
        // 부여한 품목 구분자다 — 이력조회가 부위를 안 주므로 이쪽으로 학습한다.
        gtin: parsed.gtin ?? null,
      });

      setPending((prev) => prev.filter((item) => item.key !== key));

      if (!result.success) {
        setResultCard({ card: buildFailureCard(result.error ?? "입고 처리에 실패했습니다."), scanId: null });
        return;
      }

      const data = result.data;

      if (data && "duplicate" in data) {
        const confirmed = window.confirm(
          `${data.duplicate.lastScannedAt}에 같은 번호·같은 중량을 찍었습니다.\n\n다른 박스가 맞습니까?`
        );

        if (confirmed) {
          await submitScan(value, String(parsedWeight), scanType, true, bestBefore, labeled);
        }

        return;
      }

      if (data && "status" in data) {
        // 결과는 색 있는 카드 하나로 알린다 — 표기·실중량 차이, 유통기한, 상품 자동 생성, 이력 실패 등
        // 겹치는 사정은 카드 안에 함께 담는다(판단은 lib/livestock/inbound-scan-result.ts).
        setResultCard({
          // 거절된 박스는 이미 취소돼 있어 "방금 찍은 박스 취소"를 보이지 않는다.
          scanId: data.status === "REJECTED" ? null : data.scanId,
          card: buildScanResultCard(data, {
            canSeePrice: canEditPurchasePrice,
            actualWeight: parsedWeight,
            productName: (id) => products.find((product) => product.id === id)?.name ?? "알 수 없는 상품",
            formatWon,
            formatVariance: (variance, ratio) => `${formatVarianceWeight(variance)} (${formatVarianceRatio(ratio)})`,
          }),
        });

        // 공급처 박스 바코드일 수 있다 — 소·돼지가 섞인 박스는 박스 코드밖에 없어 조회될 리가 없으니
        // 그 자리에서 쪼개기를 제안한다(사장님 확정).
        if (data.status === "EXCEPTION") {
          setSplitCandidate(value);
        }
      }

      router.refresh();
    },
    [router, labeledWeight, unitPrice, supplierId, canEditPurchasePrice, products]
  );

  /**
   * 이력번호가 정해졌을 때(스캐너 Enter든 카메라 인식이든) 공통으로 타는 경로 —
   * 그다음은 저울이다.
   *
   * 바코드에 중량이 실려 있어도 **바로 등록하지 않는다**. 그 값은 표기중량이고,
   * 재고·매입금액의 기준은 저울에 찍힌 실중량이어야 한다(24단계 설계 결정 1번).
   * 대신 실중량 칸에 미리 채워 선택해두므로, 저울 값이 같으면 Enter 한 번으로 끝난다.
   * 이미 실중량을 먼저 입력해둔 경우(저울 먼저 올린 경우)에는 바로 등록한다.
   */
  const processTraceInput = useCallback(
    (rawValue: string, scanType: ScanType) => {
      setTraceNo(rawValue);

      const parsed = parseBarcode(rawValue);

      if (parsed.weightKg && !labeledWeight.trim()) {
        setLabeledWeight(String(parsed.weightKg));

        if (!weight.trim()) {
          setWeight(String(parsed.weightKg));
        }
      }

      // 파서가 이력번호로 볼 만한 패턴을 하나도 못 찾은 값(마트 소매용 EAN-13 등)을
      // "인식 완료"라고 알려주면 실제로는 아무것도 인식 못 했는데 성공한 것처럼
      // 보인다 — 그대로 두면 헛된 정부 API 호출 → 조회 실패 → "박스 쪼개기?"
      // 배너까지 이어져 혼란만 커진다. 막지는 않되(파서가 못 잡는 정상 번호일 수도
      // 있으니) 있는 그대로 알린다.
      const notRecognized = !parsed.traceNo;

      if (!weight.trim()) {
        if (notRecognized) {
          setError(
            "⚠ 이 값에서 이력번호 형식을 찾지 못했습니다 — 마트 판매용 바코드 등 축산물 이력번호가 아닐 수 있습니다. 그래도 이대로 조회하려면 실중량을 입력한 뒤 Enter를 눌러주세요."
          );
        } else {
          setNotice("이력번호 인식 완료 — 저울에 올리고 실중량을 입력한 뒤 Enter를 눌러주세요.");
        }

        weightInputRef.current?.focus();
        // 값이 채워진 뒤에 선택해야 저울 값으로 덮어쓰기가 편하다.
        window.setTimeout(() => weightInputRef.current?.select(), 0);
        return;
      }

      if (notRecognized) {
        setError(
          "⚠ 이 값에서 이력번호 형식을 찾지 못했습니다 — 마트 판매용 바코드 등 축산물 이력번호가 아닐 수 있습니다. 그래도 이대로 조회합니다."
        );
      }

      void submitScan(rawValue, weight, scanType);
    },
    [weight, labeledWeight, submitScan]
  );

  const handleTraceKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;

    event.preventDefault();
    processTraceInput(traceNo, "BARCODE_SCAN");
  };

  // 보관 위치 지정(선택) — 입고 시점이 아니어도 나중에 언제든 채울 수 있다.
  const [locationEditScanId, setLocationEditScanId] = useState<string | null>(null);
  const [locationDraft, setLocationDraft] = useState("");
  const [locationPhotoFile, setLocationPhotoFile] = useState<File | null>(null);
  const [savingLocation, setSavingLocation] = useState(false);
  const locationPhotoInputRef = useRef<HTMLInputElement>(null);

  const openLocationEditor = (scan: InboundScanRow) => {
    setLocationEditScanId(scan.id);
    setLocationDraft(scan.storageLocation ?? "");
    setLocationPhotoFile(null);
    if (locationPhotoInputRef.current) locationPhotoInputRef.current.value = "";
  };

  const handleSaveLocation = async (scanId: string) => {
    setSavingLocation(true);

    const formData = new FormData();
    formData.append("scanId", scanId);
    formData.append("location", locationDraft);
    if (locationPhotoFile) formData.append("photo", locationPhotoFile);

    const result = await setScanStorageLocationAction(formData);

    setSavingLocation(false);

    if (!result.success) {
      setError(result.error ?? "위치 저장에 실패했습니다.");
      return;
    }

    setRows((prev) =>
      prev.map((row) =>
        row.id === scanId
          ? {
              ...row,
              storageLocation: locationDraft.trim() || null,
              storageLocationPhotoPath: result.data?.photoPath ?? row.storageLocationPhotoPath,
            }
          : row
      )
    );

    if (result.data?.photoWarning) {
      setNotice(result.data.photoWarning);
    } else {
      setNotice("보관 위치를 저장했습니다.");
    }

    setLocationEditScanId(null);
  };

  const handleViewLocationPhoto = async (photoPath: string) => {
    const result = await getScanLocationPhotoUrlAction(photoPath);

    if (!result.success || !result.data) {
      setError(result.error ?? "사진을 불러오지 못했습니다.");
      return;
    }

    window.open(result.data, "_blank", "noopener,noreferrer");
  };

  const handleWeightKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;

    event.preventDefault();
    void submitScan(traceNo, weight, "BARCODE_SCAN");
  };

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });

      streamRef.current = stream;
      setError(null);
      // <video> 태그는 cameraOn이 true일 때만 렌더링되므로, 이 시점엔 아직 DOM에
      // 없어 videoRef.current가 null이다 — 스트림 연결은 아래 useEffect(마운트 후)가 한다.
      setCameraOn(true);
    } catch {
      setError("카메라를 열 수 없습니다. 권한을 허용했는지 확인해주세요.");
    }
  }, []);

  // <video> 태그가 실제로 마운트된 뒤에 스트림을 연결한다 (마운트 전에 연결하면
  // 화면이 검게만 보이는 버그가 됨 — 실계정 테스트에서 발견).
  useEffect(() => {
    if (!cameraOn || !videoRef.current || !streamRef.current) return;

    videoRef.current.srcObject = streamRef.current;
    void videoRef.current.play();
  }, [cameraOn]);

  // 카메라가 켜져 있는 동안 주기적으로 프레임에서 바코드를 찾는다.
  useEffect(() => {
    if (!cameraOn) return;

    let cancelled = false;
    let timer: number | undefined;

    // code_128/qr_code로 좁힌 뒤로는 해당 안 되는 바코드(EAN-13 등)를 비추면
    // 정말 아무 반응이 없다 — 카메라가 고장난 건지 헷갈릴 수 있어 한동안
    // 못 읽으면 수동 입력을 안내한다.
    const hintTimer = window.setTimeout(() => {
      if (!cancelled) {
        setNotice("카메라 인식이 잘 안 되면 위 칸에 이력번호를 직접 입력해주세요.");
      }
    }, 6000);

    // BarcodeDetector는 표준화 진행 중이라 TS lib에 아직 없다.
    const BarcodeDetectorCtor = (
      window as unknown as {
        BarcodeDetector?: {
          new (options?: { formats: string[] }): {
            detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
          };
          getSupportedFormats?: () => Promise<string[]>;
        };
      }
    ).BarcodeDetector;

    // 이력번호 체계는 GS1-128(code_128)과 소비자용 QR(qr_code) 둘뿐이다(barcode-parser.ts
    // 헤더 참고). code_39/ean_13/itf까지 같이 시도하면 흔들리거나 각도가 애매한
    // 프레임에서 같은 막대무늬를 엉뚱한 형식으로 잘못 해석해 매번 다른 값이 나올
    // 수 있다(마트용 EAN-13 실측 테스트에서 발견, 2026-09-23) — 이력번호와 무관한
    // 형식을 인식 대상에서 빼서 오인식 확률을 줄인다.
    const wantedFormats = ["code_128", "qr_code"];

    const handleDetected = (rawValue: string) => {
      const value = rawValue.trim();

      if (!value) return;

      stopCamera();
      // 카메라는 이력번호만 읽는다 — 실중량은 저울 값이라 자동 제출하지 않고
      // processTraceInput이 알아서 실중량 입력을 기다리거나(비어있으면) 곧장 등록한다
      // (이미 실중량을 먼저 입력해둔 경우).
      processTraceInput(value, "CAMERA");
    };

    let zxingControls: { stop: () => void } | undefined;

    // iOS Safari 등 BarcodeDetector 미지원 브라우저는 zxing 라이브러리로 대신 읽는다.
    const startZxingFallback = async () => {
      try {
        const { BrowserMultiFormatReader, BarcodeFormat } = await import("@zxing/browser");

        if (cancelled || !videoRef.current) return;

        const reader = new BrowserMultiFormatReader();

        reader.possibleFormats = [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE];

        const controls = await reader.decodeFromVideoElement(videoRef.current, (result) => {
          if (!cancelled && result) handleDetected(result.getText());
        });

        if (cancelled) {
          controls.stop();
          return;
        }

        zxingControls = controls;
      } catch {
        if (!cancelled) {
          setError("이 기기·브라우저에서는 바코드 자동 인식을 쓸 수 없습니다. 이력번호를 직접 입력해주세요.");
          stopCamera();
        }
      }
    };

    if (!BarcodeDetectorCtor) {
      void startZxingFallback();
    } else {
      (async () => {
        let formats = wantedFormats;

        try {
          // 요청 포맷 중 브라우저가 실제로 지원하지 않는 게 섞여 있으면 생성자 자체가
          // 던질 수 있다 — 그러면 카메라는 켜지는데 인식은 영영 시작을 못 한다
          // (실계정 테스트에서 발견: 화면은 나오는데 아무 반응이 없던 원인).
          const supported = await BarcodeDetectorCtor.getSupportedFormats?.();

          if (supported && supported.length > 0) {
            formats = wantedFormats.filter((format) => supported.includes(format));
          }

          if (formats.length === 0) {
            throw new Error("NO_SUPPORTED_FORMAT");
          }

          const detector = new BarcodeDetectorCtor({ formats });

          if (cancelled) return;

          timer = window.setInterval(async () => {
            if (cancelled || !videoRef.current) return;

            try {
              const found = await detector.detect(videoRef.current);

              if (found.length > 0 && found[0].rawValue) {
                handleDetected(found[0].rawValue);
              }
            } catch {
              // 프레임 한 장 인식 실패는 정상이다 — 다음 주기에 다시 시도한다.
            }
          }, 400);
        } catch {
          if (!cancelled) {
            setError("이 기기·브라우저에서는 바코드 자동 인식을 쓸 수 없습니다. 이력번호를 직접 입력해주세요.");
            stopCamera();
          }
        }
      })();
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
      zxingControls?.stop();
      window.clearTimeout(hintTimer);
    };
  }, [cameraOn, stopCamera, processTraceInput]);

  useEffect(() => stopCamera, [stopCamera]);

  const handleResolve = async (scanId: string, productId: string) => {
    if (!productId) return;

    const result = await resolveMappingAction(scanId, productId, true);

    if (!result.success) {
      setError(result.error ?? "상품 지정에 실패했습니다.");
      return;
    }

    if (result.data?.po?.result === "REJECTED") {
      setError(`상품은 지정했지만 이 박스는 받지 않았습니다 — ${rejectionSummary(result.data.po)} 재고에는 넣지 않았습니다.`);
      router.refresh();
      return;
    }

    // 고른 상품의 부위가 이력의 부위와 다르면 알려준다 — 여기서 잘못 고르면
    // 출고 때도 안 걸리고 식당에 다른 고기가 간다.
    if (result.data?.partMismatch) {
      setError(
        `⚠️ 이 박스의 이력 부위는 '${result.data.tracePart}'인데 고르신 상품은 '${result.data.productPart}'입니다. 맞는지 확인해주세요.`
      );
    } else {
      setNotice("상품을 지정했습니다. 같은 부위는 다음부터 자동으로 연결됩니다.");
    }

    router.refresh();
  };

  const handleResolveToOrder = async (scanId: string) => {
    if (!orderTargetProductId || !orderTargetOrderId) {
      setError("상품과 주문을 모두 선택해주세요.");
      return;
    }

    setResolvingToOrder(true);
    const result = await resolveMappingToOrderAction(
      scanId,
      orderTargetProductId,
      orderTargetOrderId,
      true
    );
    setResolvingToOrder(false);

    if (!result.success) {
      setError(result.error ?? "주문 배정에 실패했습니다.");
      return;
    }

    if (result.data?.po?.result === "REJECTED") {
      setError(`이 박스는 받지 않아 주문에 배정하지 않았습니다 — ${rejectionSummary(result.data.po)}`);
      setOrderTargetScanId(null);
      setOrderTargetProductId("");
      setOrderTargetOrderId("");
      router.refresh();
      return;
    }

    if (result.data?.partMismatch) {
      setError(
        `⚠️ 이 박스의 이력 부위는 '${result.data.tracePart}'인데 고르신 상품은 '${result.data.productPart}'입니다. 맞는지 확인해주세요.`
      );
    } else {
      setNotice(
        `상품을 지정하고 주문에 ${result.data?.taken ?? 0}${
          products.find((product) => product.id === orderTargetProductId)?.unit ?? "kg"
        }만큼 바로 배정했습니다.`
      );
    }

    setOrderTargetScanId(null);
    setOrderTargetProductId("");
    setOrderTargetOrderId("");
    router.refresh();
  };

  const addSplitRow = () => {
    setSplitRows((prev) => [...prev, { id: `split-${Date.now()}`, productId: "", weight: "", traceNo: "" }]);
  };

  const removeSplitRow = (id: string) => {
    setSplitRows((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.id !== id)));
  };

  const updateSplitRow = (
    id: string,
    patch: Partial<{ productId: string; weight: string; traceNo: string }>,
  ) => {
    setSplitRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  /**
   * 한 박스를 상품 여러 개로 나눠 입고한다. 줄마다 recordScanAction을 반복
   * 호출할 뿐 — 이력번호에 UNIQUE 제약이 없다는 게 이미 잠긴 설계라(1단계) 같은
   * 코드로 여러 행이 쌓이는 데 새 백엔드 로직이 필요 없다. 중복 스캔 경고는
   * confirmDuplicate:true로 미리 넘겨 건너뛴다 — 여기서는 "같은 코드를 또 찍었다"가
   * 실수가 아니라 의도이기 때문이다.
   *
   * **줄마다 이력번호를 따로 받는다**(사장님 확정). 같은 소에서 나온 등심·안심이면
   * 박스 코드 하나로 충분하지만, 소와 돼지가 섞여 온 박스는 안에 든 고기마다
   * 이력번호가 따로 있다. 전부 박스 코드로 넣으면 나중에 그 고기가 나갈 때
   * 거래명세서에 박스 번호가 찍힌다 — 축산물이력법상 거래내역에 남겨야 하는 건
   * 그 고기의 이력번호지 박스 번호가 아니다.
   */
  const handleSplitSubmit = async () => {
    const parsed = parseBarcode(splitTraceNo);
    const boxCode = parsed.traceNo ?? splitTraceNo.trim();

    if (!boxCode) {
      setError("박스 코드를 입력해주세요.");
      return;
    }

    const validRows = splitRows.filter(
      (row) => row.productId && Number.parseFloat(row.weight) > 0
    );

    if (validRows.length < 2) {
      setError("상품을 2개 이상 고르고 무게를 입력해주세요.");
      return;
    }

    if (!supplierId) {
      setError("지금 온 거래처를 먼저 골라 주세요. 어느 거래처 물건인지 알아야 발주서와 맞춰 볼 수 있습니다.");
      supplierSelectRef.current?.focus();
      return;
    }

    setSplitSubmitting(true);
    setError(null);

    const result = await recordSplitScansAction({
      boxCode,
      supplierId,
      rows: validRows.map((row) => {
        // 줄에 이력번호를 따로 찍었으면 그걸 쓰고, 비웠으면 박스 코드를 쓴다
        // (같은 소에서 나온 부위들이면 박스 코드가 곧 이력번호다).
        const rowParsed = parseBarcode(row.traceNo ?? "");

        return {
          productId: row.productId,
          weight: Number.parseFloat(row.weight),
          traceNo: rowParsed.traceNo ?? (row.traceNo ?? "").trim(),
          gtin: rowParsed.gtin ?? parsed.gtin ?? null,
        };
      }),
    });

    if (!result.success) {
      setError(result.error ?? "박스 나눠서 입고에 실패했습니다.");
      setSplitSubmitting(false);
      return;
    }

    setSplitSubmitting(false);
    setNotice(`박스 하나를 상품 ${validRows.length}개로 나눠 입고했습니다.`);
    setSplitTraceNo("");
    setSplitRows([
      { id: "split-0", productId: "", weight: "", traceNo: "" },
      { id: "split-1", productId: "", weight: "", traceNo: "" },
    ]);
    setSplitMode(false);
    router.refresh();
  };

  // 개발용 미리보기 — 데이터·빌더는 lib/dev-samples/inbound.ts에 모아뒀다.
  // 폐기할 때 그 폴더만 지우고 아래 3줄 + 패널 JSX만 지우면 된다.
  const addSampleRow = (kind: InboundSampleKey) => {
    setRows((prev) => [buildSampleInboundRow(kind), ...prev]);
  };

  const removeSampleRow = (id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  };

  const clearSampleRows = () => {
    setRows((prev) => prev.filter((row) => !row.isSample));
  };

  // 잘못 찍은 직후의 취소 — 입고 내역을 열지 않고 결과 카드에서 바로 한다.
  const undoLastScan = async (scanId: string) => {
    if (!window.confirm("방금 찍은 박스 입고를 취소하시겠습니까?")) return;

    const result = await voidScanAction(scanId, "오스캔 취소");

    if (!result.success) {
      setError(result.error ?? "취소에 실패했습니다.");
      return;
    }

    setResultCard(null);
    setNotice("방금 찍은 박스를 취소했습니다.");
    router.refresh();
  };

  const handleVoid = async (scan: InboundScanRow) => {
    if (!window.confirm(`${scan.traceNo} (${scan.weight}${scan.unit}) 입고를 취소하시겠습니까?`)) {
      return;
    }

    const result = await voidScanAction(scan.id, "오스캔 취소");

    if (!result.success) {
      setError(result.error ?? "취소에 실패했습니다.");
      return;
    }

    router.refresh();
  };

  // 박스 나눠서 입고 — 코드 한 번 → 상품·무게 2개 이상 → 전체 입고. 카드와 칸 강조가 같은 판단을 쓴다.
  const splitBoxCode = (parseBarcode(splitTraceNo).traceNo ?? splitTraceNo.trim()).trim();
  const splitValidCount = splitRows.filter((row) => row.productId && Number.parseFloat(row.weight) > 0).length;
  const activeSplitField: "box" | "rows" | "submit" | null = splitSubmitting
    ? null
    : !splitBoxCode
      ? "box"
      : splitValidCount < 2
        ? "rows"
        : "submit";
  const splitStep: StepCardStep = splitSubmitting
    ? { title: "입고 중입니다", detail: "잠시만 기다려 주세요." }
    : !splitBoxCode
      ? {
          title: "1단계: 박스에 적힌 코드를 입력하세요",
          detail:
            "소·돼지처럼 여러 품목이 섞여 온 공급처 박스입니다. 박스 코드는 한 번만 넣습니다. 이력번호가 박스 안 고기마다 따로 있으면 아래 줄마다 적을 수 있습니다.",
        }
      : splitValidCount < 2
        ? {
            title: "2단계: 박스 안 상품과 무게를 2개 이상 입력하세요",
            detail: `박스를 열어 실제로 들어 있는 상품마다 상품을 고르고 무게를 넣습니다. 지금 ${splitValidCount}개 입력됐습니다. 파란 칸을 채우세요. 줄이 모자라면 "+ 상품 추가"를 누르세요.`,
          }
        : {
            title: '3단계: "전체 입고"를 누르세요',
            detail: `상품 ${splitValidCount}개로 나눠 한꺼번에 입고합니다. 누르기 전에는 재고가 늘어나지 않습니다.`,
            action: { label: "전체 입고", onClick: () => void handleSplitSubmit() },
          };

  // 상품이 안 정해져 재고에 못 들어간 박스들 — 상품 지정 안내 카드와 선택칸 강조의 근거.
  const unresolvedRows = rows.filter(
    (row) => !row.isSample && (row.status === "PENDING_MAPPING" || row.status === "EXCEPTION")
  );

  // 카드가 안내하는 단계의 칸·버튼을 같은 색으로 강조한다.
  const activeScanField: "trace" | "weight" | "submit" | null =
    fieldError
      ? fieldError
      : pending.length > 0
      ? null
      : !traceNo.trim()
        ? "trace"
        : !weight.trim()
          ? "weight"
          : "submit";

  // 종 배지의 "확인 필요 박스"가 이 카드로 온다 — 그 박스가 어디 있고 무엇을 하면 되는지 카드가 말해 줘야 끊기지 않는다.
  const needsCheckRows = rows.filter((row) => !row.isSample && (row.status === "PENDING_MAPPING" || row.status === "EXCEPTION"));

  // 지금 할 단계 안내 — 바코드 → 실중량 → 등록 순서를 카드가 말해 준다.
  const baseScanStep: StepCardStep =
    pending.length > 0
      ? { title: "등록 중입니다", detail: "이력번호를 조회하고 있습니다. 잠시만 기다려 주세요." }
      : !traceNo.trim()
        ? {
            title: "박스 등록 1단계: 박스의 바코드를 찍으세요",
            detail:
              "바코드를 찍으면 이력번호가 채워집니다. 방금 잘못 찍었으면 결과 카드의 '방금 찍은 박스 취소'를 누르세요. 안 찍히면 박스 라벨의 번호를 직접 입력하세요.",
            link: { label: "입고 내역 열기 (지난 박스 취소)", href: INBOUND_ANCHORS.history },
          }
        : !weight.trim()
          ? {
              title: "박스 등록 2단계: 저울에 잰 실중량(kg)을 입력하세요",
              detail: "표기중량과 달라도 저울 값이 기준입니다.",
            }
          : {
              title: "박스 등록 3단계: \"입고 등록\"을 누르세요",
              detail: "눌러야 재고가 늘어납니다.",
              action: { label: "입고 등록", onClick: () => void submitScan(traceNo, weight, "MANUAL") },
            };

  // 확인이 필요한 박스가 있으면 맨 위 "지금 할 일" 카드가 그것을 먼저 하라고 말한다 — 이 카드는 그 뒤에 새 박스를 등록하는 순서만 말한다.
  const scanIdle = !traceNo.trim() && pending.length === 0;
  const scanStep: StepCardStep =
    scanIdle && needsCheckRows.length > 0
      ? {
          title: baseScanStep.title,
          detail: `먼저 위 "지금 할 일"의 확인이 필요한 박스 ${needsCheckRows.length}개를 처리하세요. 그다음 새 박스를 등록합니다.`,
        }
      : baseScanStep;

  // 저장 전에 화면에서 미리 보여준다 — DB와 같은 규칙(lib/livestock/weight-variance.ts).
  const liveVariance = evaluateWeightVariance(
    Number.parseFloat(labeledWeight),
    Number.parseFloat(weight)
  );
  const liveAmount = calcPurchaseAmount(Number.parseFloat(weight), Number.parseFloat(unitPrice));

  // 확인이 필요한 박스는 위 '확인이 필요한 박스' 자리에 따로 두고, 입고 내역에는 나머지만 둔다(같은 박스가 두 자리에 겹쳐 그려지지 않게).
  const historyRows = rows.filter((row) => !unresolvedRows.includes(row));

  // 박스 한 줄 — '확인이 필요한 박스'와 '입고 내역' 두 자리에서 같은 모양으로 쓴다.
  const renderScanRow = (scan: InboundScanRow) => {
    const badge = STATUS_BADGE[scan.status];
    const needsProduct =
      !scan.isSample && (scan.status === "PENDING_MAPPING" || scan.status === "EXCEPTION");

    return (
      <div key={scan.id} id={`scan-${scan.id}`} style={{ ...rowStyle, scrollMarginTop: "12px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: "11px", color: "#94a3b8" }}>{formatTime(scan.createdAt)}</span>
          {scan.scannedByName && (
            <span style={{ fontSize: "11px", color: "#475569", fontWeight: 600 }}>
              {scan.scannedByName}
            </span>
          )}
          <span style={{ fontFamily: "monospace", fontSize: "13px" }}>{scan.traceNo}</span>
          {(scan.productName || scan.status !== "VOIDED") && (
            <span style={{ fontWeight: 600 }}>{scan.productName ?? "상품 미지정"}</span>
          )}
          <span style={{ fontWeight: 600 }}>
            {scan.weight}
            {scan.unit}
          </span>

          {!needsProduct && scan.status !== "VOIDED" && scan.labeledWeight !== null && scan.weightVariance !== null && (
            <span
              title={`표기 ${scan.labeledWeight}${scan.unit} → 실측 ${scan.weight}${scan.unit}`}
              style={{
                fontSize: "11px",
                fontWeight: 700,
                borderRadius: "4px",
                padding: "3px 6px",
                ...(evaluateWeightVariance(scan.labeledWeight, scan.weight)?.exceeded
                  ? { backgroundColor: "#fef3c7", color: "#92400e" }
                  : { backgroundColor: "#f1f5f9", color: "#64748b" }),
              }}
            >
              표기 {scan.labeledWeight} / {formatVarianceWeight(scan.weightVariance)}
            </span>
          )}

          {!needsProduct && scan.status !== "VOIDED" && scan.purchaseAmount !== null && (
            <span style={{ fontSize: "11px", color: "#475569" }}>
              매입 {formatWon(scan.purchaseAmount)}
              {scan.purchaseSupplier ? ` · ${scan.purchaseSupplier}` : ""}
            </span>
          )}
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              backgroundColor: badge.bg,
              color: badge.color,
              borderRadius: "4px",
              padding: "3px 7px",
            }}
          >
            {badge.label}
          </span>

          {scan.isSample && (
            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                backgroundColor: "#e0e7ff",
                color: "#3730a3",
                borderRadius: "4px",
                padding: "3px 7px",
              }}
            >
              샘플
            </span>
          )}
        </div>

        {scan.isSample && scan.sampleNote && (
          <p style={{ fontSize: "11px", color: "#64748b", margin: "2px 0 0", width: "100%" }}>
            {scan.sampleNote}
          </p>
        )}

        {!scan.isSample && !needsProduct && scan.status !== "VOIDED" && (
          <div style={{ width: "100%", display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
            {scan.storageLocation && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  backgroundColor: "#f1f5f9",
                  color: "#334155",
                  borderRadius: "4px",
                  padding: "3px 7px",
                }}
              >
                📍 {scan.storageLocation}
              </span>
            )}

            {scan.storageLocationPhotoPath && (
              <button
                type="button"
                onClick={() => void handleViewLocationPhoto(scan.storageLocationPhotoPath!)}
                style={{ ...buttonStyle, padding: "3px 8px", fontSize: "11px" }}
              >
                위치 사진 보기
              </button>
            )}

            {locationEditScanId === scan.id ? (
              <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                <input
                  list="storage-location-suggestions"
                  value={locationDraft}
                  onChange={(event) => setLocationDraft(event.target.value)}
                  placeholder="예: 냉장고1-상단"
                  style={{ ...inputStyle, width: "auto", padding: "5px 8px", fontSize: "12px" }}
                />
                <input
                  ref={locationPhotoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(event) => setLocationPhotoFile(event.target.files?.[0] ?? null)}
                  style={{ fontSize: "11px", width: "150px" }}
                />
                <button
                  type="button"
                  disabled={savingLocation}
                  onClick={() => void handleSaveLocation(scan.id)}
                  style={{ ...buttonStyle, padding: "5px 10px", fontSize: "12px" }}
                >
                  {savingLocation ? "저장 중…" : "저장"}
                </button>
                <button
                  type="button"
                  onClick={() => setLocationEditScanId(null)}
                  style={{ border: "none", background: "none", color: "#94a3b8", fontSize: "12px", cursor: "pointer" }}
                >
                  닫기
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => openLocationEditor(scan)}
                style={{ border: "none", background: "none", color: "#2563eb", fontSize: "11px", cursor: "pointer" }}
              >
                {scan.storageLocation ? "위치 수정" : "위치 지정(선택)"}
              </button>
            )}
          </div>
        )}

        {(() => {
          const report = scan.isSample
            ? scan.sampleRequirementReport
            : scanRequirements[scan.id];

          if (needsProduct) {
            // 재고에 아직 안 들어간 박스는 칸별 대조표(축종·등급·원산지 …)가 아니라 할 일 한 줄만 보여 준다.
            return (
              <p style={{ margin: "4px 0 0", width: "100%", fontSize: "12px", color: "#7f1d1d", lineHeight: 1.5 }}>
                {scan.status === "EXCEPTION"
                  ? "이력을 찾지 못했습니다. 번호가 틀렸으면 '번호 바꾸기', 맞으면 '다시 조회'(시스템도 자동으로 다시 조회합니다). 급하면 상품을 직접 지정하세요."
                  : "이력은 확인됐지만 상품을 못 정했습니다. 아래에서 상품을 고르세요."}
              </p>
            );
          }

          // 취소된 박스에는 대조표가 의미 없다.
          if (scan.status === "VOIDED") return null;

          return report ? <ScanRequirementSummary report={report} /> : null;
        })()}

        {needsProduct && declinedSplitTraceNos.has(scan.traceNo) && (
          <p style={{ fontSize: "11px", color: "#92400e", margin: "2px 0 0", width: "100%" }}>
            ⚠ 쪼개기 안 함으로 확인됨 — 아래에서 상품을 하나로 지정하면 이 무게 전체가 그
            상품 재고로 들어갑니다. 실제로 여러 상품이 섞인 박스라면 취소하고 "박스 나눠서
            입고"로 다시 입력하세요.
          </p>
        )}

        <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
          {scan.status === "EXCEPTION" && !scan.isSample && (
            <TraceNoFixer scanId={scan.id} traceNo={scan.traceNo} compact />
          )}

          {needsProduct && products.length === 0 && (
            <Link
              href={archivedProductCount > 0 ? "/dashboard/products?status=archived" : "/dashboard/products"}
              style={{ fontSize: "12px", fontWeight: 700, color: "#1d4ed8", textDecoration: "underline" }}
            >
              {archivedProductCount > 0
                ? `지정할 상품이 없습니다 — 보관된 상품 ${archivedProductCount}개가 있습니다. 상품 관리에서 '복원'하면 여기서 고를 수 있습니다. 시험 입력이면 이 박스를 '취소'하세요`
                : "지정할 상품이 없습니다 — 양·가공육은 상품 관리에서 직접 등록하고, 소·돼지·닭·오리·계란은 이력이 조회되면 입고 스캔으로 자동 등록됩니다(상품 관리에서 미리 등록해 둘 수도 있습니다). 시험 입력이면 이 박스를 '취소'하세요"}
            </Link>
          )}

          {needsProduct && products.length > 0 && (
            <select
              defaultValue=""
              onChange={(event) => void handleResolve(scan.id, event.target.value)}
              aria-label="상품 지정"
              style={{ ...inputStyle, ...HIGHLIGHT_FIELD, width: "auto", padding: "6px 8px", fontSize: "12px" }}
            >
              <option value="">상품 선택…</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {composeProductDisplayName(product.category, product.name)}
                  {product.grade ? ` (${product.grade})` : ""}
                  {product.is_active === false ? " · 판매중지" : ""}
                </option>
              ))}
            </select>
          )}

          {needsProduct && shippableOrders.length > 0 && (
            <button
              type="button"
              onClick={() => {
                // 다른 행에서 골라둔 상품/주문 선택값이 남아있으면 이 행에
                // 그대로 미리 채워진 것처럼 보여 잘못 배정될 수 있다(code-review 지적).
                setOrderTargetProductId("");
                setOrderTargetOrderId("");
                setOrderTargetScanId(orderTargetScanId === scan.id ? null : scan.id);
              }}
              style={{ ...buttonStyle, padding: "6px 10px", fontSize: "12px" }}
            >
              {orderTargetScanId === scan.id ? "취소" : "주문에 바로 배정"}
            </button>
          )}

          {scan.isSample ? (
            <button
              type="button"
              onClick={() => removeSampleRow(scan.id)}
              style={{ ...buttonStyle, padding: "6px 10px", fontSize: "12px" }}
            >
              삭제
            </button>
          ) : (
            scan.status !== "VOIDED" && (
              <button
                type="button"
                onClick={() => void handleVoid(scan)}
                style={{ ...buttonStyle, padding: "6px 10px", fontSize: "12px" }}
              >
                취소
              </button>
            )
          )}
        </div>

        {orderTargetScanId === scan.id && (
          <div
            style={{
              display: "flex",
              gap: "6px",
              alignItems: "center",
              flexWrap: "wrap",
              width: "100%",
              marginTop: "6px",
              padding: "8px",
              backgroundColor: "#f8fafc",
              borderRadius: "8px",
            }}
          >
            <span style={{ fontSize: "12px", color: "#475569" }}>
              고객이 요청해서 들어온 박스를 바로 그 주문으로 보냅니다 —
            </span>
            <select
              value={orderTargetProductId}
              onChange={(event) => setOrderTargetProductId(event.target.value)}
              aria-label="배정할 상품"
              style={{ ...inputStyle, width: "auto", padding: "6px 8px", fontSize: "12px" }}
            >
              <option value="">상품 선택…</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {composeProductDisplayName(product.category, product.name)}
                  {product.grade ? ` (${product.grade})` : ""}
                  {product.is_active === false ? " · 판매중지" : ""}
                </option>
              ))}
            </select>
            <select
              value={orderTargetOrderId}
              onChange={(event) => setOrderTargetOrderId(event.target.value)}
              aria-label="배정할 주문"
              style={{ ...inputStyle, width: "auto", padding: "6px 8px", fontSize: "12px" }}
            >
              <option value="">주문 선택…</option>
              {shippableOrders.map((order) => (
                <option key={order.id} value={order.id}>
                  {order.orderNumber} · {order.retailerName}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={resolvingToOrder}
              onClick={() => void handleResolveToOrder(scan.id)}
              style={{
                ...buttonStyle,
                padding: "6px 10px",
                fontSize: "12px",
                fontWeight: 700,
                opacity: resolvingToOrder ? 0.6 : 1,
              }}
            >
              {resolvingToOrder ? "배정 중…" : "배정 확정"}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <StepCard who="현장" step={scanStep} />

      {resultCard ? (
        <ResultCardView
          card={resultCard.card}
          onDismiss={() => setResultCard(null)}
          onUndo={resultCard?.scanId ? () => void undoLastScan(resultCard.scanId as string) : undefined}
        />
      ) : null}

      <section id="inbound-scan-form" style={{ ...panelStyle, scrollMarginTop: "12px" }}>
        <div style={{ marginBottom: "10px" }}>
          <label htmlFor="current_supplier" style={{ ...labelStyle, color: "#0f172a", fontWeight: 700 }}>
            지금 온 거래처
          </label>
          {suppliers.length === 0 ? (
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#991b1b" }}>
              등록된 거래처가 없습니다. 발주 관리의 “거래처 관리”에서 먼저 등록해야 입고할 수 있습니다.{" "}
              <a href="/dashboard/purchase-orders" style={{ color: "#1d4ed8", fontWeight: 700 }}>
                발주 관리로
              </a>
            </p>
          ) : (
            <select
              ref={supplierSelectRef}
              id="current_supplier"
              value={supplierId}
              onChange={(event) => handleSupplierChange(event.target.value)}
              style={{ ...inputStyle, maxWidth: "320px", borderColor: supplierId ? "#cbd5e1" : "#0f172a" }}
            >
              <option value="">거래처를 고르세요</option>
              {suppliers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            <label htmlFor="trace_no" style={labelStyle}>
              이력번호 (바코드)
            </label>
            <input
              ref={traceInputRef}
              id="trace_no"
              value={traceNo}
              onChange={(event) => {
                setTraceNo(event.target.value);
                setFieldError(null);
              }}
              onKeyDown={handleTraceKeyDown}
              inputMode="numeric"
              autoComplete="off"
              placeholder="스캐너로 찍거나 직접 입력"
              style={{ ...inputStyle, ...(activeScanField === "trace" ? HIGHLIGHT_FIELD : {}) }}
            />
          </div>

          <div style={{ width: "110px" }}>
            <label htmlFor="labeled_weight" style={labelStyle}>
              표기중량 (kg)
            </label>
            <input
              id="labeled_weight"
              type="number"
              min="0"
              step="0.001"
              value={labeledWeight}
              onChange={(event) => setLabeledWeight(event.target.value)}
              placeholder="라벨 값"
              style={{ ...inputStyle, backgroundColor: "#f8fafc" }}
            />
          </div>

          <div style={{ width: "120px" }}>
            <label htmlFor="weight" style={{ ...labelStyle, color: "#0f172a", fontWeight: 700 }}>
              실중량 (kg) ⚖️
            </label>
            <input
              ref={weightInputRef}
              id="weight"
              type="number"
              min="0"
              step="0.001"
              value={weight}
              onChange={(event) => {
                setWeight(event.target.value);
                setFieldError(null);
              }}
              onKeyDown={handleWeightKeyDown}
              placeholder="19.800"
              style={{
                ...inputStyle,
                borderColor: "#0f172a",
                ...(activeScanField === "weight" ? HIGHLIGHT_FIELD : {}),
              }}
            />
          </div>

          {canEditPurchasePrice ? (
            <div style={{ width: "120px" }}>
              <label htmlFor="unit_price" style={labelStyle}>
                매입단가 (원/kg)
              </label>
              <input
                id="unit_price"
                type="number"
                min="0"
                step="100"
                value={unitPrice}
                onChange={(event) => setUnitPrice(event.target.value)}
                placeholder="상품 기본값"
                style={inputStyle}
              />
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void submitScan(traceNo, weight, "MANUAL")}
            style={{
              ...buttonStyle,
              backgroundColor: "#0f172a",
              color: "#fff",
              ...(activeScanField === "submit" ? HIGHLIGHT_BUTTON : {}),
            }}
          >
            입고 등록
          </button>

          {cameraSupported && !cameraOn && (
            <button type="button" onClick={() => void startCamera()} style={buttonStyle}>
              📷 카메라
            </button>
          )}

          {cameraOn && (
            <button
              type="button"
              onClick={stopCamera}
              style={{ ...buttonStyle, borderColor: "#fca5a5", color: "#b91c1c" }}
            >
              카메라 끄기
            </button>
          )}

          <button
            type="button"
            onClick={() => setSplitMode((prev) => !prev)}
            style={{ ...buttonStyle, marginLeft: "auto" }}
          >
            {splitMode ? "박스 나눠서 입고 닫기" : "박스 나눠서 입고 (상품 여러 개)"}
          </button>
        </div>

        {liveVariance && (
          <div
            style={{
              ...messageStyle,
              backgroundColor: liveVariance.exceeded ? "#fef3c7" : "#f1f5f9",
              color: liveVariance.exceeded ? "#92400e" : "#475569",
            }}
          >
            표기 {labeledWeight}kg / 실측 {weight}kg → {formatVarianceWeight(liveVariance.variance)} (
            {formatVarianceRatio(liveVariance.ratio)})
            {liveVariance.exceeded ? " · 허용 오차(±2%)를 넘습니다" : ""}
            {liveAmount !== null ? ` · 매입 ${formatWon(liveAmount)}` : ""}
          </div>
        )}

        <p style={{ fontSize: "11px", color: "#94a3b8", margin: "8px 0 0" }}>
          바코드를 찍으면 표기중량이 자동으로 채워지고 실중량 칸으로 넘어갑니다. 저울 값을 입력하고
          Enter를 누르면 등록됩니다 — 재고와 매입금액은 <strong>실중량</strong> 기준입니다.
          단가·거래처는 다음 박스에도 그대로 남습니다.
          {!cameraSupported && " (이 브라우저는 카메라 스캔을 지원하지 않아 스캐너/수동 입력만 가능합니다)"}
        </p>

        {cameraOn && (
          <video
            ref={videoRef}
            muted
            playsInline
            style={{
              width: "100%",
              maxHeight: "260px",
              objectFit: "cover",
              borderRadius: "8px",
              marginTop: "10px",
              backgroundColor: "#000",
            }}
          />
        )}

        {error && <div style={{ ...messageStyle, backgroundColor: "#fee2e2", color: "#991b1b" }}>{error}</div>}
        {notice && <div style={{ ...messageStyle, backgroundColor: "#eff6ff", color: "#1e40af" }}>{notice}</div>}

        {splitCandidate && !splitMode && (
          <div
            style={{
              ...messageStyle,
              backgroundColor: "#fffbeb",
              color: "#92400e",
              display: "flex",
              flexWrap: "wrap",
              gap: "8px",
              alignItems: "center",
            }}
          >
            <span style={{ flex: "1 1 240px" }}>
              공급처 박스 바코드일 수 있습니다. 소·돼지처럼 여러 품목이 섞인 박스라면 열어서
              품목별로 나눠 넣어주세요.
            </span>
            <button
              type="button"
              onClick={() => {
                setSplitTraceNo(splitCandidate);
                setSplitMode(true);
                setSplitCandidate(null);
              }}
              style={{ ...buttonStyle, padding: "6px 12px", fontSize: "12px" }}
            >
              이 박스 쪼개기
            </button>
            <button
              type="button"
              onClick={() => {
                setDeclinedSplitTraceNos((prev) => new Set(prev).add(splitCandidate));
                setSplitCandidate(null);
              }}
              style={{
                border: "none",
                background: "none",
                color: "#92400e",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              아니오
            </button>
          </div>
        )}
      </section>

      {splitMode && (
        <section style={panelStyle}>
          <div style={{ marginBottom: "10px" }}>
            <StepCard who="현장" step={splitStep} />
          </div>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>
            박스 나눠서 입고
          </div>
          <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 10px" }}>
            공급자가 서로 다른 상품을 한 박스에 코드 하나로 묶어 보낸 경우입니다. 코드는 한 번만
            입력하고, 박스를 열어 실제로 들어있는 상품마다 무게를 나눠 입력해주세요.
          </p>

          <input
            value={splitTraceNo}
            onChange={(event) => setSplitTraceNo(event.target.value)}
            placeholder="박스에 적힌 이력번호/코드 (한 번만)"
            style={{ ...inputStyle, marginBottom: "10px", ...(activeSplitField === "box" ? HIGHLIGHT_FIELD : {}) }}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {splitRows.map((row) => (
              <div key={row.id} style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={row.productId}
                  onChange={(event) => updateSplitRow(row.id, { productId: event.target.value })}
                  aria-label="상품 선택"
                  style={{
                    ...inputStyle,
                    width: "auto",
                    flex: "1 1 220px",
                    ...(activeSplitField === "rows" && !row.productId ? HIGHLIGHT_FIELD : {}),
                  }}
                >
                  <option value="">상품 선택…</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {composeProductDisplayName(product.category, product.name)}
                      {product.grade ? ` (${product.grade})` : ""}
                            {product.is_active === false ? " · 판매중지" : ""}
                    </option>
                  ))}
                </select>
                <input
                  value={row.weight}
                  onChange={(event) => updateSplitRow(row.id, { weight: event.target.value })}
                  placeholder="무게(kg)"
                  inputMode="decimal"
                  style={{
                    ...inputStyle,
                    width: "110px",
                    ...(activeSplitField === "rows" && !(Number.parseFloat(row.weight) > 0) ? HIGHLIGHT_FIELD : {}),
                  }}
                />
                {/* 소·돼지가 섞여 온 박스는 안에 든 고기마다 이력번호가 따로 있다.
                    비우면 위 박스 코드를 그대로 쓴다(같은 소에서 나온 부위들인 경우). */}
                <input
                  value={row.traceNo ?? ""}
                  onChange={(event) => updateSplitRow(row.id, { traceNo: event.target.value })}
                  placeholder="이력번호(비우면 박스 코드)"
                  style={{ ...inputStyle, width: "auto", flex: "1 1 190px", fontFamily: "monospace" }}
                />
                <button
                  type="button"
                  onClick={() => removeSplitRow(row.id)}
                  disabled={splitRows.length <= 1}
                  style={{ ...buttonStyle, padding: "6px 10px", fontSize: "12px" }}
                >
                  삭제
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
            <button type="button" onClick={addSplitRow} style={buttonStyle}>
              + 상품 추가
            </button>
            <button
              type="button"
              disabled={splitSubmitting}
              onClick={() => void handleSplitSubmit()}
              style={{
                ...buttonStyle,
                backgroundColor: "#0f172a",
                color: "#fff",
                opacity: splitSubmitting ? 0.6 : 1,
                ...(activeSplitField === "submit" ? HIGHLIGHT_BUTTON : {}),
              }}
            >
              {splitSubmitting ? "입고 중…" : "전체 입고"}
            </button>
          </div>
        </section>
      )}

      {SHOW_DEV_SAMPLES && (
        <section style={panelStyle}>
          <DevSamplePanel
            kinds={INBOUND_SAMPLE_KINDS}
            onAdd={addSampleRow}
            onClearAll={clearSampleRows}
            hasSamples={rows.some((row) => row.isSample)}
            description="실제 API·DB를 안 건드리고 화면에만 미리보기 행을 띄웁니다 — 검토용이며 새로고침하면 사라집니다."
            buttonStyle={{ ...buttonStyle, fontSize: "12px" }}
            containerStyle={{ padding: 0 }}
          />
        </section>
      )}

      {pending.length > 0 && (
        <section style={panelStyle}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>등록 중</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {pending.map((item) => (
              <div key={item.key} style={{ ...rowStyle, opacity: 0.6 }}>
                <span style={{ fontFamily: "monospace" }}>{item.traceNo}</span>
                <span>{item.weight}kg</span>
                <span style={{ fontSize: "12px", color: "#64748b" }}>검증 중…</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {unresolvedRows.length > 0 && (
        <section id="inbound-unresolved" style={{ ...panelStyle, border: "2px solid #fca5a5", backgroundColor: "#fff7f7", scrollMarginTop: "12px" }}>
          <div style={{ fontSize: "14px", fontWeight: 800, color: "#991b1b" }}>확인이 필요한 박스 {unresolvedRows.length}개</div>
          <p style={{ fontSize: "12px", color: "#475569", margin: "4px 0 10px", lineHeight: 1.5 }}>
            재고에 아직 안 들어간 박스입니다. 박스 옆에서 상품을 지정하면 재고가 늘고, 이력을 못 찾은 박스는 번호를 바로잡거나 다시 조회하세요.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>{unresolvedRows.map(renderScanRow)}</div>
        </section>
      )}

      <section id="inbound-history" style={{ ...panelStyle, scrollMarginTop: "12px" }}>
        <button
          type="button"
          onClick={() => setHistoryOpen((open) => !open)}
          aria-expanded={historyOpen}
          style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "transparent", border: "none", padding: 0, cursor: "pointer", fontSize: "13px", fontWeight: 700, color: "#0f172a" }}
        >
          <span>
            입고 내역 <span style={{ color: "#94a3b8", fontWeight: 400 }}>지금까지 찍은 박스 {historyRows.length}건 · 지난 박스 취소·보관 위치</span>
          </span>
          <span style={{ color: "#64748b" }}>{historyOpen ? "접기 ▲" : "열기 ▼"}</span>
        </button>

        {historyOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
            {historyRows.length === 0 ? (
              <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>아직 입고 기록이 없습니다.</p>
            ) : (
              historyRows.map(renderScanRow)
            )}
          </div>
        )}
      </section>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  backgroundColor: "#fff",
  padding: "14px",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "#475569",
  marginBottom: "4px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px",
  fontSize: "14px",
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "#cbd5e1",
  borderRadius: "6px",
  backgroundColor: "#fff",
};

const buttonStyle: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: "13px",
  fontWeight: 600,
  borderRadius: "6px",
  border: "1px solid #e2e8f0",
  backgroundColor: "#f8fafc",
  color: "#334155",
  cursor: "pointer",
};

const messageStyle: React.CSSProperties = {
  marginTop: "10px",
  padding: "10px 12px",
  borderRadius: "8px",
  fontSize: "13px",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "10px",
  flexWrap: "wrap",
  borderBottom: "1px solid #f1f5f9",
  paddingBottom: "8px",
};
