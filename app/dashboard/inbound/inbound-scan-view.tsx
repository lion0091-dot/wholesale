"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { composeProductDisplayName } from "@/lib/products/display-name";
import { recordScanAction, resolveMappingAction, voidScanAction, type ScanType } from "./actions";
import { parseBarcode } from "@/lib/livestock/barcode-parser";
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
  unit: string;
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
  products: ScanProductOption[];
}

export function InboundScanView({ initialScans, products }: Props) {
  const router = useRouter();

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
          setNotice("이력을 찾지 못해 '이력 확인 필요'로 기록했습니다. 입고 자체는 저장됐습니다.");
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

      if (!weight.trim()) {
        setNotice("이력번호 인식 완료 — 저울에 올리고 실중량을 입력한 뒤 Enter를 눌러주세요.");
        weightInputRef.current?.focus();
        // 값이 채워진 뒤에 선택해야 저울 값으로 덮어쓰기가 편하다.
        window.setTimeout(() => weightInputRef.current?.select(), 0);
        return;
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

    const wantedFormats = ["code_128", "code_39", "ean_13", "qr_code", "itf"];

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
      </section>

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
              const needsProduct = scan.status === "PENDING_MAPPING" || scan.status === "EXCEPTION";

              return (
                <div key={scan.id} style={rowStyle}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "11px", color: "#94a3b8" }}>{formatTime(scan.createdAt)}</span>
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
                  </div>

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

                    {scan.status !== "VOIDED" && (
                      <button
                        type="button"
                        onClick={() => void handleVoid(scan)}
                        style={{ ...buttonStyle, padding: "6px 10px", fontSize: "12px" }}
                      >
                        취소
                      </button>
                    )}
                  </div>
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
