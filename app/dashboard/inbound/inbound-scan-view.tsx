"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { composeProductDisplayName } from "@/lib/products/display-name";
import { recordScanAction, resolveMappingAction, voidScanAction, type ScanType } from "./actions";
import { parseBarcode } from "@/lib/livestock/barcode-parser";

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
  const [weight, setWeight] = useState("");
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
    async (rawTraceNo: string, rawWeight: string, scanType: ScanType, confirmDuplicate = false) => {
      // 스캐너가 보낸 값은 순수 이력번호일 수도, GS1-128 물류 바코드일 수도,
      // 소비자용 QR(URL)일 수도 있다. 한 곳에서 해석해 이력번호를 뽑는다.
      const parsed = parseBarcode(rawTraceNo);
      const value = parsed.traceNo ?? rawTraceNo.trim();

      if (!value) {
        setError("이력번호를 입력해주세요.");
        return;
      }

      // GS1-128에는 중량이 들어 있다 — 손으로 안 쳐도 되게 바코드 값을 우선한다.
      const typedWeight = Number.parseFloat(rawWeight);
      const parsedWeight =
        Number.isFinite(typedWeight) && typedWeight > 0 ? typedWeight : parsed.weightKg ?? NaN;

      if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
        setError("중량을 입력해주세요.");
        weightInputRef.current?.focus();
        return;
      }

      setError(null);
      setNotice(null);

      // 낙관적 UI — 응답을 기다리지 않고 먼저 목록에 얹는다.
      const key = `${value}-${Date.now()}`;
      setPending((prev) => [{ key, traceNo: value, weight: parsedWeight }, ...prev]);

      // 다음 박스를 바로 찍을 수 있게 입력칸을 즉시 비운다.
      setTraceNo("");
      setWeight("");
      traceInputRef.current?.focus();

      const result = await recordScanAction({
        traceNo: value,
        weight: parsedWeight,
        scanType,
        confirmDuplicate,
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
          await submitScan(value, String(parsedWeight), scanType, true);
        }

        return;
      }

      if (data && "status" in data) {
        if (data.autoCreated) {
          setNotice(
            `'${data.autoCreated.productName}' 상품을 새로 만들어 입고했습니다.` +
              " 상품 관리에서 판매가를 넣고 '판매중'으로 바꿔야 고객에게 보입니다."
          );
        } else if (data.status === "EXCEPTION") {
          setNotice("이력을 찾지 못해 '이력 확인 필요'로 기록했습니다. 입고 자체는 저장됐습니다.");
        } else if (data.status === "PENDING_MAPPING") {
          setNotice("부위를 알 수 없어 자동 등록이 안 됩니다. 아래 목록에서 상품을 한 번만 지정해주세요.");
        }
      }

      router.refresh();
    },
    [router]
  );

  /** 스캐너(HID)는 이력번호를 입력하고 Enter를 보낸다 — 중량이 비었으면 중량칸으로 넘긴다. */
  const handleTraceKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;

    event.preventDefault();

    // GS1-128처럼 바코드 자체에 중량이 실려 있으면 중량 입력을 건너뛴다.
    const parsed = parseBarcode(traceNo);

    if (!weight.trim() && !parsed.weightKg) {
      weightInputRef.current?.focus();
      return;
    }

    void submitScan(traceNo, weight, "BARCODE_SCAN");
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
    if (!weight.trim()) {
      setError("카메라로 찍기 전에 중량을 먼저 입력해주세요.");
      weightInputRef.current?.focus();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });

      streamRef.current = stream;
      setCameraOn(true);
      setError(null);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch {
      setError("카메라를 열 수 없습니다. 권한을 허용했는지 확인해주세요.");
    }
  }, [weight]);

  // 카메라가 켜져 있는 동안 주기적으로 프레임에서 바코드를 찾는다.
  useEffect(() => {
    if (!cameraOn) return;

    let cancelled = false;
    // BarcodeDetector는 표준화 진행 중이라 TS lib에 아직 없다.
    const DetectorCtor = (window as unknown as { BarcodeDetector: new (options?: unknown) => { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
    const detector = new DetectorCtor({
      formats: ["code_128", "code_39", "ean_13", "qr_code", "itf"],
    });

    const timer = window.setInterval(async () => {
      if (cancelled || !videoRef.current) return;

      try {
        const found = await detector.detect(videoRef.current);

        if (found.length > 0 && found[0].rawValue) {
          const value = found[0].rawValue.trim();

          stopCamera();
          void submitScan(value, weight, "CAMERA");
        }
      } catch {
        // 프레임 한 장 인식 실패는 정상이다 — 다음 주기에 다시 시도한다.
      }
    }, 400);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [cameraOn, weight, stopCamera, submitScan]);

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

          <div style={{ width: "120px" }}>
            <label htmlFor="weight" style={labelStyle}>
              중량 (kg)
            </label>
            <input
              ref={weightInputRef}
              id="weight"
              type="number"
              min="0"
              step="0.01"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
              onKeyDown={handleWeightKeyDown}
              placeholder="8.2"
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

        <p style={{ fontSize: "11px", color: "#94a3b8", margin: "8px 0 0" }}>
          바코드를 찍으면 중량 칸으로 넘어가고, 중량 입력 후 Enter를 누르면 등록됩니다.
          물류 바코드(GS1-128)처럼 중량이 들어 있으면 그대로 등록됩니다.
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
                    <span>
                      {scan.weight}
                      {scan.unit}
                    </span>
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
