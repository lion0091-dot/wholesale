"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseBarcode } from "@/lib/livestock/barcode-parser";
import {
  recordOutboundScanAction,
  getOutboundProgressAction,
  type OutboundProgressRow,
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
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const traceInputRef = useRef<HTMLInputElement>(null);

  const loadProgress = useCallback(async (id: string) => {
    if (!id) {
      setProgress([]);
      return;
    }

    const result = await getOutboundProgressAction(id);

    if (result.success) {
      setProgress(result.data ?? []);
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
    setTraceNo("");
    traceInputRef.current?.focus();

    // 바코드에 중량이 실려 있으면 그만큼만 가져간다(박스를 통째로 쓰지 않는 경우).
    const result = await recordOutboundScanAction(orderId, value, parsed.weightKg);

    if (!result.success || !result.data) {
      setError(result.error ?? "출고 처리에 실패했습니다.");
      return;
    }

    const data = result.data;

    setMessage(
      data.remainingNeeded > 0
        ? `${data.productName} ${data.taken}kg 출고. ${data.remainingNeeded}kg 더 필요합니다.`
        : `${data.productName} 출고 완료 (${data.assigned}/${data.ordered}kg).`
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
        {error && <div style={{ ...noticeStyle, backgroundColor: "#fee2e2", color: "#991b1b" }}>{error}</div>}
      </section>

      {progress.length > 0 && (
        <section style={panelStyle}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
            출고 진행 {allDone && <span style={{ color: "#166534" }}>· 전부 채웠습니다</span>}
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
