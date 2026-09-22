"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseBarcode } from "@/lib/livestock/barcode-parser";
import {
  recordOutboundScanAction,
  getOutboundProgressAction,
  getPickingListAction,
  previewShipmentAction,
  finalizeShipmentAction,
  type OutboundProgressRow,
  type PickingRow,
  type ShipmentPreviewRow,
} from "./actions";

export interface ShippableOrder {
  id: string;
  orderNumber: string;
  status: string;
  orderedAt: string;
  retailerName: string;
}

interface Props {
  orders: ShippableOrder[];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" });
}

export function OutboundScanView({ orders }: Props) {
  const router = useRouter();

  const [orderId, setOrderId] = useState(orders[0]?.id ?? "");
  const [traceNo, setTraceNo] = useState("");
  const [progress, setProgress] = useState<OutboundProgressRow[]>([]);
  const [picking, setPicking] = useState<PickingRow[]>([]);
  // 마감 확인 대화상자. null 이면 닫힌 상태.
  const [confirming, setConfirming] = useState<ShipmentPreviewRow[] | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const traceInputRef = useRef<HTMLInputElement>(null);

  const loadProgress = useCallback(async (id: string) => {
    if (!id) {
      setProgress([]);
      setPicking([]);
      return;
    }

    const [progressResult, pickingResult] = await Promise.all([
      getOutboundProgressAction(id),
      getPickingListAction(id),
    ]);

    if (progressResult.success) {
      setProgress(progressResult.data ?? []);
    }

    if (pickingResult.success) {
      setPicking(pickingResult.data ?? []);
    }
  }, []);

  useEffect(() => {
    void loadProgress(orderId);
    traceInputRef.current?.focus();
  }, [orderId, loadProgress]);

  const submit = async (rawValue: string) => {
    if (!orderId) {
      setError("먼저 발주서를 선택해주세요.");
      return;
    }

    // 스캐너가 보낸 값이 GS1-128이나 QR일 수 있다 — 입고와 같은 파서를 태운다.
    const parsed = parseBarcode(rawValue);
    const value = parsed.traceNo ?? rawValue.trim();

    if (!value) {
      setError("이력번호를 읽지 못했습니다.");
      return;
    }

    setError(null);
    setWarning(null);
    setTraceNo("");
    traceInputRef.current?.focus();

    // 바코드에 중량이 실려 있으면 그만큼만 가져간다(박스를 통째로 쓰지 않는 경우).
    const result = await recordOutboundScanAction(orderId, value, parsed.weightKg);

    if (!result.success || !result.data) {
      setError(result.error ?? "출고 처리에 실패했습니다.");
      return;
    }

    const data = result.data;

    // 입고 때 매핑이 틀렸으면 출고에서도 안 걸린다 — 이력의 진짜 부위와
    // 상품 부위를 대조해 알려준다(막지는 않는다).
    if (data.partMismatch) {
      setWarning(
        `이 박스의 이력 부위는 '${data.tracePart}'인데 상품은 '${data.productPart}'입니다. 박스를 다시 확인해주세요.`
      );
    }

    if (data.daysLeft !== null && data.daysLeft <= 3) {
      setWarning(
        (data.partMismatch ? `${data.tracePart}/${data.productPart} 부위 확인 필요. ` : "") +
          `이 박스는 유통기한이 ${data.daysLeft}일 남았습니다 (${data.bestBefore}).`
      );
    }

    setMessage(
      data.remainingNeeded > 0
        ? `${data.productName} ${data.taken}kg 출고. ${data.remainingNeeded}kg 더 필요합니다.`
        : `${data.productName} 출고 완료 (${data.assigned}/${data.ordered}kg).`
    );

    await loadProgress(orderId);
    router.refresh();
  };

  /**
   * 출고 마감. 주문보다 덜 나갔으면 DB가 SHIPMENT_SHORT 를 던지므로,
   * 그때 차이를 보여주고 사람이 확인하면 다시 부른다.
   */
  const finalize = async (confirmShort: boolean) => {
    if (!orderId || finalizing) {
      return;
    }

    setFinalizing(true);
    setError(null);

    const result = await finalizeShipmentAction(orderId, confirmShort);

    if (!result.success) {
      if (result.error === "SHIPMENT_SHORT") {
        const preview = await previewShipmentAction(orderId);
        setFinalizing(false);

        if (preview.success) {
          setConfirming(preview.data ?? []);
        } else {
          setError(preview.error ?? "출고 내역을 불러오지 못했습니다.");
        }

        return;
      }

      setFinalizing(false);
      setError(result.error ?? "출고 마감에 실패했습니다.");
      return;
    }

    setFinalizing(false);
    setConfirming(null);
    setMessage(
      result.data?.wasShort
        ? `출고 마감. 실제 중량 기준 ${result.data.totalAmount.toLocaleString()}원으로 확정했습니다.`
        : "출고 마감했습니다."
    );

    await loadProgress(orderId);
    router.refresh();
  };

  const allDone =
    progress.length > 0 && progress.every((row) => row.scannedQty >= row.orderedQty);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <section style={panelStyle}>
        <label htmlFor="order" style={labelStyle}>
          발주서
        </label>
        <select
          id="order"
          value={orderId}
          onChange={(event) => {
            setOrderId(event.target.value);
            setMessage(null);
            setError(null);
          }}
          style={inputStyle}
        >
          <option value="">선택하세요</option>
          {orders.map((order) => (
            <option key={order.id} value={order.id}>
              {order.orderNumber} · {order.retailerName} · {formatDate(order.orderedAt)}
              {order.status === "shipping" ? " (배송중)" : ""}
            </option>
          ))}
        </select>

        {orders.length === 0 && (
          <p style={{ fontSize: "13px", color: "#94a3b8", margin: "8px 0 0" }}>
            출고할 발주서가 없습니다. 발주 관리에서 먼저 확정해주세요.
          </p>
        )}

        <div style={{ marginTop: "12px" }}>
          <label htmlFor="trace" style={labelStyle}>
            나갈 박스 바코드
          </label>
          <input
            ref={traceInputRef}
            id="trace"
            value={traceNo}
            onChange={(event) => setTraceNo(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit(traceNo);
              }
            }}
            disabled={!orderId}
            autoComplete="off"
            placeholder="스캐너로 찍거나 직접 입력 후 Enter"
            style={inputStyle}
          />
          <p style={{ fontSize: "11px", color: "#94a3b8", margin: "6px 0 0" }}>
            찍는 순간 그 박스로 배정이 바뀝니다. 주문 수량을 넘겨 찍으면 거부됩니다.
          </p>
        </div>

        {message && <div style={{ ...noticeStyle, backgroundColor: "#dcfce7", color: "#166534" }}>{message}</div>}
        {warning && (
          <div style={{ ...noticeStyle, backgroundColor: "#fef3c7", color: "#92400e", fontWeight: 600 }}>
            ⚠️ {warning}
          </div>
        )}
        {error && <div style={{ ...noticeStyle, backgroundColor: "#fee2e2", color: "#991b1b" }}>{error}</div>}
      </section>

      {confirming && (
        <section
          style={{
            ...panelStyle,
            border: "2px solid #f59e0b",
            backgroundColor: "#fffbeb",
          }}
        >
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#92400e", marginBottom: "4px" }}>
            ⚠️ 주문보다 적게 나갔습니다
          </div>
          <div style={{ fontSize: "12px", color: "#92400e", marginBottom: "10px" }}>
            이대로 마감하면 <strong>실제 나간 중량 기준으로 금액이 확정</strong>됩니다.
            거래명세서에도 실제 중량이 찍힙니다.
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {confirming.map((row) => {
              const short = row.diffQty < 0;

              return (
                <div
                  key={row.productId}
                  style={{
                    padding: "8px 10px",
                    borderRadius: "8px",
                    backgroundColor: "#fff",
                    border: "1px solid #fde68a",
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a" }}>
                    {row.productName}
                  </div>
                  <div style={{ fontSize: "12px", color: "#475569", marginTop: "2px" }}>
                    주문 {row.orderedQty}
                    {row.unit} / 실제 {row.shippedQty}
                    {row.unit}
                    {short && (
                      <strong style={{ color: "#b45309" }}>
                        {" "}
                        ({row.diffQty}
                        {row.unit})
                      </strong>
                    )}
                  </div>
                  <div style={{ fontSize: "12px", color: "#475569" }}>
                    {row.orderedAmount.toLocaleString()}원
                    {short && (
                      <>
                        {" → "}
                        <strong style={{ color: "#b45309" }}>
                          {row.shippedAmount.toLocaleString()}원
                        </strong>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
            <button
              type="button"
              onClick={() => void finalize(true)}
              disabled={finalizing}
              style={{
                flex: 1,
                padding: "10px",
                fontSize: "13px",
                fontWeight: 700,
                borderRadius: "6px",
                border: "none",
                backgroundColor: finalizing ? "#94a3b8" : "#b45309",
                color: "#fff",
                cursor: finalizing ? "default" : "pointer",
              }}
            >
              {finalizing ? "처리 중…" : "이대로 마감"}
            </button>

            <button
              type="button"
              onClick={() => {
                setConfirming(null);
                traceInputRef.current?.focus();
              }}
              disabled={finalizing}
              style={{
                flex: 1,
                padding: "10px",
                fontSize: "13px",
                fontWeight: 600,
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                backgroundColor: "#fff",
                color: "#334155",
                cursor: finalizing ? "default" : "pointer",
              }}
            >
              더 스캔하기
            </button>
          </div>
        </section>
      )}

      {picking.length > 0 && (
        <section style={panelStyle}>
          <div style={{ marginBottom: "10px" }}>
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>가져올 박스</span>
            <span style={{ fontSize: "11px", color: "#64748b", marginLeft: "6px" }}>
              오래된 박스부터 (선입선출)
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {picking.map((row) => (
              <div
                key={`${row.boxId}-${row.alreadyPicked ? "done" : "todo"}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "1px solid #e2e8f0",
                  backgroundColor: row.alreadyPicked ? "#f8fafc" : "#fff",
                  opacity: row.alreadyPicked ? 0.6 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a" }}>
                    {row.productName}
                    {row.grade && (
                      <span style={{ fontSize: "11px", color: "#64748b", marginLeft: "6px" }}>
                        {row.grade}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "11px", color: "#64748b", fontFamily: "monospace" }}>
                    {row.traceNo}
                  </div>
                  {row.slaughterDate && (
                    <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                      도축 {row.slaughterDate} · 박스 {row.boxWeight}
                      {row.unit}
                    </div>
                  )}
                  {row.daysLeft !== null && row.daysLeft <= 3 && (
                    <div style={{ fontSize: "11px", fontWeight: 700, color: "#b45309" }}>
                      유통기한 {row.daysLeft < 0 ? `${-row.daysLeft}일 지남` : `${row.daysLeft}일 남음`} (
                      {row.bestBefore})
                    </div>
                  )}
                </div>

                <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <div
                    style={{
                      fontSize: "15px",
                      fontWeight: 700,
                      color: row.alreadyPicked ? "#64748b" : "#b45309",
                    }}
                  >
                    {row.suggestedQty}
                    {row.unit}
                  </div>
                  <div style={{ fontSize: "11px", color: row.alreadyPicked ? "#166534" : "#94a3b8" }}>
                    {row.alreadyPicked ? "출고 완료" : "가져오기"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {progress.length > 0 && (
        <section style={panelStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
              marginBottom: "10px",
            }}
          >
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
              출고 진행 {allDone && <span style={{ color: "#166534" }}>· 전부 채웠습니다</span>}
            </span>

            {/* 소분해서 나가는 봉지에는 원래 이력번호를 표시해야 한다 —
                박스 라벨은 창고에 남으므로 새 라벨이 필요하다. */}
            <Link
              href={`/dashboard/outbound/labels/${orderId}`}
              target="_blank"
              style={{
                marginLeft: "auto",
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                borderRadius: "6px",
                border: "1px solid #e2e8f0",
                backgroundColor: "#f8fafc",
                color: "#334155",
                textDecoration: "none",
              }}
            >
              소분 라벨 인쇄
            </Link>

            <button
              type="button"
              onClick={() => void finalize(false)}
              disabled={finalizing}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 700,
                borderRadius: "6px",
                border: "none",
                backgroundColor: finalizing ? "#94a3b8" : "#0f172a",
                color: "#fff",
                cursor: finalizing ? "default" : "pointer",
              }}
            >
              {finalizing ? "처리 중…" : "출고 마감"}
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {progress.map((row) => {
              const done = row.scannedQty >= row.orderedQty;
              const ratio = Math.min(100, (row.scannedQty / Math.max(1, row.orderedQty)) * 100);

              return (
                <div key={row.productId} style={{ borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600 }}>{row.productName}</span>
                    <span style={{ color: done ? "#166534" : "#b45309", fontWeight: 700 }}>
                      {row.scannedQty} / {row.orderedQty}
                      {row.unit}
                    </span>
                  </div>

                  <div
                    style={{
                      height: "5px",
                      borderRadius: "3px",
                      backgroundColor: "#f1f5f9",
                      marginTop: "6px",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${ratio}%`,
                        height: "100%",
                        backgroundColor: done ? "#16a34a" : "#f59e0b",
                      }}
                    />
                  </div>

                  {row.traceNos && (
                    <div style={{ fontSize: "11px", color: "#64748b", marginTop: "4px", fontFamily: "monospace" }}>
                      {row.traceNos}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
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

const noticeStyle: React.CSSProperties = {
  marginTop: "10px",
  padding: "10px 12px",
  borderRadius: "8px",
  fontSize: "13px",
};
