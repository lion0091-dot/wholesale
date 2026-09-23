"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { composeProductDisplayName } from "@/lib/products/display-name";
import {
  recordScanAction,
  resolveMappingAction,
  resolveMappingToOrderAction,
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
 * 브라우저 내장 바코드 인식(BarcodeDetector) 지원 여부.
 * Android Chrome은 지원하고 iOS Safari는 아직 지원하지 않는다. 미지원 환경에서는
 * 카메라 버튼을 감추고 블루투스 스캐너/수동 입력으로 쓰게 둔다.
 */
function hasBarcodeDetector(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

interface Props {
  initialScans: InboundScanRow[];
  /**
   * 스캔 id → 필수항목 체크리스트. 서버에서 공공조회·명세서를 붙여 만든다.
   * 방금 찍어서 아직 서버 데이터가 없는 줄은 여기 없고, 새로고침되면 채워진다.
   */
  scanRequirements: Record<string, ScanRequirementReport>;
  products: ScanProductOption[];
  shippableOrders: ShippableOrderOption[];
  /**
   * 대기중(PENDING) 명세서 줄에 적힌 이력번호 전체(대문자). "박스 나눠서 입고"에서
   * 줄마다 쓴 번호가 여기 없으면 명세서와 대조되지 않는다는 경고 배너를 띄운다.
   * 명세서 자체가 없으면(빈 배열) 대조할 게 없으니 배너를 안 띄운다.
   */
  pendingDocumentTraceNos: string[];
  /**
   * 명세서에는 있는데 아직 스캔되지 않은 줄 — "명세서 대기 품목" 목록에 띄워
   * 탭하면 이력번호 입력칸에 채워준다(2026-09-24, 사장님 지침: 바코드가 지저분하거나
   * 로트번호를 손으로 옮겨 적어야 할 때의 보조 수단 — 스캔 자체를 대체하지 않는다).
   */
  awaitingDocumentLines: AwaitingDocumentLine[];
  /** 이 업체가 그동안 직접 입력한 위치 이름 — 고정 목록 대신 제안용으로 쓴다. */
  storageLocationSuggestions: string[];
}

export interface AwaitingDocumentLine {
  id: string;
  traceNo: string;
  itemName: string | null;
  labeledWeight: number | null;
  unitPrice: number | null;
  supplierName: string | null;
}

/** 오픈 직전 Vercel에서 이 값을 지우거나 false로 바꾸면 샘플 패널이 전부 사라진다. */
const SHOW_DEV_SAMPLES = process.env.NEXT_PUBLIC_SHOW_DEV_SAMPLES === "true";

/** 값이 어디서 왔는지 한눈에 — 출처마다 색을 달리한다. */
const SOURCE_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  SCAN: { label: "스캔", bg: "#e0f2fe", fg: "#075985" },
  TRACE_API: { label: "이력조회", bg: "#dcfce7", fg: "#166534" },
  DOCUMENT: { label: "명세서", bg: "#ede9fe", fg: "#5b21b6" },
  PRODUCT: { label: "상품", bg: "#f1f5f9", fg: "#475569" },
};

/**
 * 입고 한 건이 플랫폼 기준을 채웠는지 항목별로 뿌린다.
 *
 * 빠진 것만 보여주지 않고 **채워진 값과 그 출처까지** 보여준다 — 공공조회와
 * 명세서 중 어느 쪽에서 온 값인지 알아야 틀렸을 때 어디를 고칠지 알 수 있고,
 * 양쪽이 어긋나는 경우도 드러나야 하기 때문이다(사장님 요청).
 */
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
              title={field.conflict ?? field.hint ?? undefined}
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

        {!report.documentMatched ? (
          <span style={{ fontSize: "11px", color: "#94a3b8" }}>명세서 연결 안 됨</span>
        ) : null}
      </div>

      {report.fields
        .filter((field) => field.conflict)
        .map((field) => (
          <p
            key={`conflict-${field.key}`}
            style={{ margin: "4px 0 0", fontSize: "11px", color: "#b45309" }}
          >
            {field.conflict} — 어느 쪽이 맞는지 확인이 필요합니다.
          </p>
        ))}

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
  pendingDocumentTraceNos,
  awaitingDocumentLines,
  storageLocationSuggestions,
}: Props) {
  const router = useRouter();

  const documentTraceNoSet = useMemo(() => new Set(pendingDocumentTraceNos), [pendingDocumentTraceNos]);

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
  // 매입단가·매입처는 한 차에 들어오는 물건이 대체로 같아서 스캔 후에도 비우지 않는다.
  const [unitPrice, setUnitPrice] = useState("");
  const [supplier, setSupplier] = useState("");
  const [rows, setRows] = useState<InboundScanRow[]>(initialScans);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraSupported, setCameraSupported] = useState(false);

  const traceInputRef = useRef<HTMLInputElement>(null);
  const weightInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    setCameraSupported(hasBarcodeDetector());
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
      // 스캐너가 보낸 값은 순수 이력번호일 수도, GS1-128 물류 바코드일 수도,
      // 소비자용 QR(URL)일 수도 있다. 한 곳에서 해석해 이력번호를 뽑는다.
      const parsed = parseBarcode(rawTraceNo);
      const value = parsed.traceNo ?? rawTraceNo.trim();

      if (!value) {
        setError("이력번호를 입력해주세요.");
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
        setError("저울에 찍힌 실중량을 입력해주세요.");
        weightInputRef.current?.focus();
        return;
      }

      const typedPrice = Number.parseFloat(unitPrice);
      const purchaseUnitPrice = Number.isFinite(typedPrice) && typedPrice >= 0 ? typedPrice : null;

      setError(null);
      setNotice(null);

      // 낙관적 UI — 응답을 기다리지 않고 먼저 목록에 얹는다.
      const key = `${value}-${Date.now()}`;
      setPending((prev) => [{ key, traceNo: value, weight: parsedWeight }, ...prev]);

      // 다음 박스를 바로 찍을 수 있게 입력칸을 즉시 비운다.
      // 단가·매입처는 한 차 분량이 대체로 같으므로 남겨둔다.
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
        purchaseSupplier: supplier.trim() || null,
        // 바코드의 상품코드. 이력번호가 소 한 마리를 가리킨다면 이건 공급처가
        // 부여한 품목 구분자다 — 이력조회가 부위를 안 주므로 이쪽으로 학습한다.
        gtin: parsed.gtin ?? null,
      });

      setPending((prev) => prev.filter((item) => item.key !== key));

      if (!result.success) {
        setError(result.error ?? "입고 처리에 실패했습니다.");
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
        // 표기중량과 실중량이 크게 다르면 돈이 새는 자리다. 막지는 않고 크게 알린다.
        if (data.varianceExceeded && data.weightVariance !== null && data.varianceRatio !== null) {
          setError(
            `⚠️ 표기 ${data.labeledWeight}kg / 실측 ${parsedWeight}kg — ` +
              `${formatVarianceWeight(data.weightVariance)} (${formatVarianceRatio(data.varianceRatio)}) 차이가 납니다. ` +
              "입고는 실중량으로 기록했습니다. 매입처에 확인하세요."
          );
        }

        // 기한이 지난 물건도 입고는 받는다 — 안 받으면 반품·폐기 근거가 안 남는다.
        // 대신 그 자리에서 알린다.
        if (data.daysLeft !== null && data.daysLeft < 0) {
          setError(
            `유통기한이 ${-data.daysLeft}일 지난 박스입니다 (${data.bestBefore}). 입고는 기록했지만 출고되지 않습니다.`
          );
        } else if (data.daysLeft !== null && data.daysLeft <= 3) {
          setNotice(`유통기한이 ${data.daysLeft}일 남았습니다 (${data.bestBefore}). 먼저 내보내세요.`);
        } else if (data.autoCreated) {
          setNotice(
            `'${data.autoCreated.productName}' 상품을 새로 만들어 입고했습니다.` +
              " 상품 관리에서 판매가를 넣고 '판매중'으로 바꿔야 고객에게 보입니다."
          );
        } else if (data.status === "EXCEPTION") {
          // 이력조회가 실패하는 흔한 이유 하나가 "공급처 박스 바코드를 찍었다"이다.
          // 소·돼지가 섞여 온 박스는 박스 코드밖에 없어 조회될 리가 없다. 그 자리에서
          // 쪼개기를 제안한다 — 나중에 목록에서 찾아 들어가는 것보다 낫다(사장님 확정).
          setSplitCandidate(value);

          // "조회를 아예 못 함"(설정 문제) / "일시 오류일 수 있음" / "조회는 됐는데 없음"은
          // 원인이 완전히 달라 같은 문구로 뭉뚱그리면 안 된다(2026-09-23 발견).
          if (data.failIsNotConfigured) {
            setNotice(
              "이력 조회 기능이 아직 설정되지 않아 확인하지 못했습니다(인증키 미등록). " +
                "입고 자체는 정상 저장됐습니다 — 다시 찍어도 지금은 통과하지 않으니, " +
                "아래 목록에서 상품을 직접 지정해주세요."
            );
          } else if (data.failReason === "API_ERROR") {
            // 조회 자체는 됐지만 저장 단계 등에서 오류가 난 경우 — 일시적일 수 있어
            // "재시도해도 안 된다"고 단정하지 않는다. 실제 오류 사유를 그대로 보여준다.
            setNotice(
              `이력 조회 중 오류가 있었습니다${data.failDetail ? `(${data.failDetail})` : ""}. ` +
                "입고는 저장됐습니다 — 다시 찍어보시거나, 계속 안 되면 아래 목록에서 상품을 직접 지정해주세요."
            );
          } else {
            setNotice(
              "이 번호는 이력에서 확인되지 않았습니다. 입고는 저장됐으니 바코드를 다시 확인해보시고, " +
                "맞다면 아래 목록에서 상품을 직접 지정해주세요."
            );
          }
        } else if (data.status === "PENDING_MAPPING") {
          setNotice("부위를 알 수 없어 자동 등록이 안 됩니다. 아래 목록에서 상품을 한 번만 지정해주세요.");
        } else if (data.purchaseAmount !== null) {
          setNotice(
            `매입 ${formatWon(data.purchaseAmount)} (실중량 ${parsedWeight}kg × ${formatWon(
              data.purchaseUnitPrice ?? 0
            )}) 로 기록했습니다.`
          );
        } else {
          setNotice("매입단가가 없어 금액은 비워뒀습니다. 매입 정산 화면에서 채울 수 있습니다.");
        }
      }

      router.refresh();
    },
    [router, labeledWeight, unitPrice, supplier]
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

  /**
   * 명세서 대기 품목을 탭했을 때 — 바코드가 안 찍히거나 로트번호를 손으로
   * 옮겨 적어야 할 때의 보조 수단. 이력번호 입력칸만 채우고 실제 등록은
   * 여전히 사람이 실중량을 입력하고 확정해야 한다(스캔을 대신하지 않는다).
   */
  const handleUseAwaitingLine = (line: AwaitingDocumentLine) => {
    setTraceNo(line.traceNo);
    setError(null);
    setNotice(`"${line.traceNo}"를 입력칸에 채웠습니다 — 실중량을 확인하고 Enter를 눌러주세요.`);
    weightInputRef.current?.focus();
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
        BarcodeDetector: {
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
              const value = found[0].rawValue.trim();

              stopCamera();
              // 카메라는 이력번호만 읽는다 — 실중량은 저울 값이라 자동 제출하지 않고
              // processTraceInput이 알아서 실중량 입력을 기다리거나(비어있으면) 곧장 등록한다
              // (이미 실중량을 먼저 입력해둔 경우).
              processTraceInput(value, "CAMERA");
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

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
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

    setSplitSubmitting(true);
    setError(null);

    for (const row of validRows) {
      // 줄에 이력번호를 따로 찍었으면 그걸 쓰고, 비웠으면 박스 코드를 쓴다
      // (같은 소에서 나온 부위들이면 박스 코드가 곧 이력번호다).
      const rowParsed = parseBarcode(row.traceNo ?? "");
      const rowTrace = (rowParsed.traceNo ?? (row.traceNo ?? "").trim()) || boxCode;

      const result = await recordScanAction({
        traceNo: rowTrace,
        weight: Number.parseFloat(row.weight),
        scanType: "MANUAL",
        productId: row.productId,
        confirmDuplicate: true,
        memo: rowTrace === boxCode ? "박스 나눠서 입고" : `박스 나눠서 입고 (박스 ${boxCode})`,
        gtin: rowParsed.gtin ?? parsed.gtin ?? null,
      });

      if (!result.success) {
        const productName =
          products.find((product) => product.id === row.productId)?.name ?? "상품";
        setError(`${productName} 처리 중 실패했습니다: ${result.error}`);
        setSplitSubmitting(false);
        return;
      }
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

  // 저장 전에 화면에서 미리 보여준다 — DB와 같은 규칙(lib/livestock/weight-variance.ts).
  const liveVariance = evaluateWeightVariance(
    Number.parseFloat(labeledWeight),
    Number.parseFloat(weight)
  );
  const liveAmount = calcPurchaseAmount(Number.parseFloat(weight), Number.parseFloat(unitPrice));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <section style={panelStyle}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            <label htmlFor="trace_no" style={labelStyle}>
              이력번호 (바코드)
            </label>
            <input
              ref={traceInputRef}
              id="trace_no"
              value={traceNo}
              onChange={(event) => setTraceNo(event.target.value)}
              onKeyDown={handleTraceKeyDown}
              inputMode="numeric"
              autoComplete="off"
              placeholder="스캐너로 찍거나 직접 입력"
              style={inputStyle}
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
              onChange={(event) => setWeight(event.target.value)}
              onKeyDown={handleWeightKeyDown}
              placeholder="19.800"
              style={{ ...inputStyle, borderColor: "#0f172a" }}
            />
          </div>

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

          <div style={{ width: "130px" }}>
            <label htmlFor="purchase_supplier" style={labelStyle}>
              매입처
            </label>
            <input
              id="purchase_supplier"
              value={supplier}
              onChange={(event) => setSupplier(event.target.value)}
              placeholder="도축장·거래처"
              autoComplete="off"
              style={inputStyle}
            />
          </div>

          <button
            type="button"
            onClick={() => void submitScan(traceNo, weight, "MANUAL")}
            style={{ ...buttonStyle, backgroundColor: "#0f172a", color: "#fff" }}
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
          단가·매입처는 다음 박스에도 그대로 남습니다.
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

      {awaitingDocumentLines.length > 0 && (
        <section style={panelStyle}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "4px" }}>
            명세서 대기 품목 <span style={{ color: "#94a3b8", fontWeight: 400 }}>아직 안 들어온 것</span>
          </div>
          <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 10px" }}>
            바코드가 잘 안 찍히거나 로트번호를 옮겨 적어야 할 때, 아래에서 탭하면 이력번호 칸에
            채워집니다. 실제 등록은 실중량을 확인하고 눌러야 끝납니다.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {awaitingDocumentLines.map((line) => (
              <button
                key={line.id}
                type="button"
                onClick={() => handleUseAwaitingLine(line)}
                style={{
                  ...rowStyle,
                  cursor: "pointer",
                  textAlign: "left",
                  border: "1px dashed #cbd5e1",
                  display: "flex",
                  gap: "8px",
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <span style={{ fontWeight: 600 }}>{line.itemName ?? "품목명 없음"}</span>
                <span style={{ fontFamily: "monospace", fontSize: "12px", color: "#475569" }}>
                  {line.traceNo}
                </span>
                {line.labeledWeight !== null && (
                  <span style={{ fontSize: "12px", color: "#64748b" }}>{line.labeledWeight}kg</span>
                )}
                {line.unitPrice !== null && (
                  <span style={{ fontSize: "12px", color: "#64748b" }}>{formatWon(line.unitPrice)}</span>
                )}
                {line.supplierName && (
                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>{line.supplierName}</span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      {splitMode && (
        <section style={panelStyle}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>
            박스 나눠서 입고
          </div>
          <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 10px" }}>
            공급자가 서로 다른 상품을 한 박스에 코드 하나로 묶어 보낸 경우입니다. 코드는 한 번만
            입력하고, 박스를 열어 실제로 들어있는 상품마다 무게를 나눠 입력해주세요.
          </p>

          {(() => {
            // 대기중 명세서가 있을 때만 대조한다 — 명세서 자체가 없는 공급처는 대조할
            // 대상이 없으니 경고를 안 띄운다(사장님 확정).
            if (documentTraceNoSet.size === 0) return null;

            const boxCode = (parseBarcode(splitTraceNo).traceNo ?? splitTraceNo.trim()).toUpperCase();

            const unmatchedRowNumbers = splitRows
              .map((row, index) => {
                if (!row.productId || !(Number.parseFloat(row.weight) > 0)) return null;

                const rowParsed = parseBarcode(row.traceNo ?? "");
                const effectiveTrace = (
                  (rowParsed.traceNo ?? (row.traceNo ?? "").trim()) || boxCode
                ).toUpperCase();

                return effectiveTrace && !documentTraceNoSet.has(effectiveTrace) ? index + 1 : null;
              })
              .filter((value): value is number => value !== null);

            if (unmatchedRowNumbers.length === 0) return null;

            return (
              <p
                style={{
                  ...messageStyle,
                  backgroundColor: "#fffbeb",
                  color: "#92400e",
                  marginBottom: "10px",
                }}
              >
                ⚠ {unmatchedRowNumbers.join(", ")}번 줄의 이력번호가 업로드된 명세서에서 확인되지
                않았습니다. 실제로 맞는 번호인지 다시 확인해주세요.
              </p>
            );
          })()}

          <input
            value={splitTraceNo}
            onChange={(event) => setSplitTraceNo(event.target.value)}
            placeholder="박스에 적힌 이력번호/코드 (한 번만)"
            style={{ ...inputStyle, marginBottom: "10px" }}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {splitRows.map((row) => (
              <div key={row.id} style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={row.productId}
                  onChange={(event) => updateSplitRow(row.id, { productId: event.target.value })}
                  aria-label="상품 선택"
                  style={{ ...inputStyle, width: "auto", flex: "1 1 220px" }}
                >
                  <option value="">상품 선택…</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {composeProductDisplayName(product.category, product.name)}
                      {product.grade ? ` (${product.grade})` : ""}
                    </option>
                  ))}
                </select>
                <input
                  value={row.weight}
                  onChange={(event) => updateSplitRow(row.id, { weight: event.target.value })}
                  placeholder="무게(kg)"
                  inputMode="decimal"
                  style={{ ...inputStyle, width: "110px" }}
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

      <section style={panelStyle}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
          입고 내역 <span style={{ color: "#94a3b8", fontWeight: 400 }}>최근 100건</span>
        </div>

        {pending.length === 0 && rows.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>아직 입고 기록이 없습니다.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {pending.map((item) => (
              <div key={item.key} style={{ ...rowStyle, opacity: 0.6 }}>
                <span style={{ fontFamily: "monospace" }}>{item.traceNo}</span>
                <span>{item.weight}kg</span>
                <span style={{ fontSize: "12px", color: "#64748b" }}>검증 중…</span>
              </div>
            ))}

            {rows.map((scan) => {
              const badge = STATUS_BADGE[scan.status];
              const needsProduct =
                !scan.isSample && (scan.status === "PENDING_MAPPING" || scan.status === "EXCEPTION");

              return (
                <div key={scan.id} style={rowStyle}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "11px", color: "#94a3b8" }}>{formatTime(scan.createdAt)}</span>
                    {scan.scannedByName && (
                      <span style={{ fontSize: "11px", color: "#475569", fontWeight: 600 }}>
                        {scan.scannedByName}
                      </span>
                    )}
                    <span style={{ fontFamily: "monospace", fontSize: "13px" }}>{scan.traceNo}</span>
                    <span style={{ fontWeight: 600 }}>{scan.productName ?? "상품 미지정"}</span>
                    <span style={{ fontWeight: 600 }}>
                      {scan.weight}
                      {scan.unit}
                    </span>

                    {scan.labeledWeight !== null && scan.weightVariance !== null && (
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

                    {scan.purchaseAmount !== null && (
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

                  {!scan.isSample && (
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
                            취소
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

                    return report ? <ScanRequirementList report={report} /> : null;
                  })()}

                  {needsProduct && declinedSplitTraceNos.has(scan.traceNo) && (
                    <p style={{ fontSize: "11px", color: "#92400e", margin: "2px 0 0", width: "100%" }}>
                      ⚠ 쪼개기 안 함으로 확인됨 — 아래에서 상품을 하나로 지정하면 이 무게 전체가 그
                      상품 재고로 들어갑니다. 실제로 여러 상품이 섞인 박스라면 취소하고 "박스 나눠서
                      입고"로 다시 입력하세요.
                    </p>
                  )}

                  <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                    {needsProduct && (
                      <select
                        defaultValue=""
                        onChange={(event) => void handleResolve(scan.id, event.target.value)}
                        aria-label="상품 지정"
                        style={{ ...inputStyle, width: "auto", padding: "6px 8px", fontSize: "12px" }}
                      >
                        <option value="">상품 선택…</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {composeProductDisplayName(product.category, product.name)}
                            {product.grade ? ` (${product.grade})` : ""}
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
            })}
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
  border: "1px solid #cbd5e1",
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
