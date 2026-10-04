"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseBarcode } from "@/lib/livestock/barcode-parser";
import { pickOutboundGuide } from "@/lib/livestock/outbound-next-step";
import {
  recordOutboundScanAction,
  getOutboundProgressAction,
  getBoxLeftoverAction,
  getPickingListAction,
  previewShipmentAction,
  finalizeShipmentAction,
  type OutboundProgressRow,
  type PickingRow,
  type ShipmentPreviewRow,
} from "./actions";
import { getScanLocationPhotoUrlAction } from "../inbound/actions";

export interface ShippableOrder {
  id: string;
  orderNumber: string;
  status: string;
  orderedAt: string;
  /** 출고 마감(금액 확정)이 끝났나 — 마감된 주문서에는 더 찍을 수 없다. */
  finalized: boolean;
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

  // 아직 마감 안 된 주문서부터 — 마감된 주문서가 기본 선택이면 첫 스캔이 "이미 마감됨"으로 거부된다.
  // 기본은 오래된 순(먼저 들어온 주문부터 처리). 토글은 목록 표시만 뒤집고, "다음 주문" 판단은 그대로 오래된 순을 쓴다.
  const [newestFirst, setNewestFirst] = useState(false);
  const [orderId, setOrderId] = useState((orders.find((order) => !order.finalized) ?? orders[0])?.id ?? "");
  const [traceNo, setTraceNo] = useState("");
  // 저울에 단 실제 중량(kg). 비어 있으면 예전처럼 바코드 중량 또는 박스 장부 잔량을 쓴다.
  const [weight, setWeight] = useState("");
  // 실중량이 박스 장부 잔량보다 적을 때, 박스에 고기가 남았는지 현장이 답할 때까지 출고를 멈춰 둔 스캔.
  const [pendingChoice, setPendingChoice] = useState<{ value: string; weight: number; remaining: number } | null>(null);
  const [progress, setProgress] = useState<OutboundProgressRow[]>([]);
  const [picking, setPicking] = useState<PickingRow[]>([]);
  // 마감 확인 대화상자. null 이면 닫힌 상태.
  const [confirming, setConfirming] = useState<ShipmentPreviewRow[] | null>(null);
  // 마감 확인 창에서 상품별로 고객에게 청구할 수량(마이그레이션 230). 기본은 주문 수량이다.
  const [billedInputs, setBilledInputs] = useState<Record<string, string>>({});
  const [finalizing, setFinalizing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const traceInputRef = useRef<HTMLInputElement>(null);

  const handleViewLocationPhoto = async (photoPath: string) => {
    // 서버에서 주소를 받은 뒤 window.open을 부르면 모바일 사파리·카톡 인앱이 팝업으로 보고 막는다 — 눌린 즉시 빈 창을 먼저 연다.
    const popup = window.open("", "_blank");
    let result: Awaited<ReturnType<typeof getScanLocationPhotoUrlAction>>;

    try {
      result = await getScanLocationPhotoUrlAction(photoPath);
    } catch {
      popup?.close();
      setError("사진을 불러오지 못했습니다. 네트워크를 확인하고 다시 눌러 주세요.");
      return;
    }

    if (!result.success || !result.data) {
      popup?.close();
      setError(result.error ?? "사진을 불러오지 못했습니다.");
      return;
    }

    if (popup) {
      popup.opener = null;
      popup.location.href = result.data;
    } else {
      window.location.href = result.data;
    }
  };

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

  /** 출고 기록 + (다 썼음이면) 감량 처리까지. */
  const record = async (value: string, scanWeight: number | null, exhausted: boolean) => {
    const result = await recordOutboundScanAction(orderId, value, scanWeight, exhausted);

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

    const shrinkageText = data.shrinkage > 0 ? ` 박스 장부 잔량 ${data.shrinkage}kg은 감량으로 기록했습니다.` : "";

    if (data.shrinkageError) {
      setError(data.shrinkageError);
    }

    setMessage(
      (data.remainingNeeded > 0
        ? `${data.productName} ${data.taken}kg 출고. ${data.remainingNeeded}kg 더 필요합니다.`
        : `${data.productName} 출고 완료 (${data.assigned}/${data.ordered}kg).`) + shrinkageText
    );

    await loadProgress(orderId);
    router.refresh();
  };

  const submit = async (rawValue: string) => {
    if (!orderId) {
      setError("먼저 주문서를 선택해주세요.");
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

    // 직원이 단 실중량이 있으면 그것이 우선이다. 없으면 바코드에 실린 중량(있을 때)만큼만 가져간다.
    const typedWeight = Number.parseFloat(weight);
    const hasTypedWeight = Number.isFinite(typedWeight) && typedWeight > 0;
    const scanWeight = hasTypedWeight ? typedWeight : parsed.weightKg;

    setWeight("");

    // 실중량이 박스 장부 잔량보다 적으면 "남았는지/다 썼는지"를 물어본다 — 답하기 전에는 출고하지 않는다.
    if (hasTypedWeight) {
      const leftover = await getBoxLeftoverAction(orderId, value, typedWeight);

      if (leftover.success && leftover.data !== null && leftover.data !== undefined) {
        setPendingChoice({ value, weight: typedWeight, remaining: leftover.data });
        return;
      }
    }

    await record(value, scanWeight, false);
  };

  const answerChoice = async (exhausted: boolean) => {
    if (!pendingChoice) {
      return;
    }

    const { value, weight: pendingWeight } = pendingChoice;

    setPendingChoice(null);
    await record(value, pendingWeight, exhausted);
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

    // 확인 창이 떠 있으면 거기서 적은 청구 수량을 보낸다. 범위를 벗어난 값은 DB가 거부하기 전에 먼저 알려준다.
    let billed: Array<{ productId: string; qty: number }> | undefined;

    if (confirmShort && confirming) {
      billed = [];

      for (const row of confirming) {
        const qty = Number.parseFloat(billedInputs[row.productId] ?? String(row.shippedQty > 0 ? row.orderedQty : 0));

        if (!Number.isFinite(qty) || qty < 0 || qty > row.orderedQty) {
          setFinalizing(false);
          setError(`${row.productName} 청구 수량은 0 이상, 주문 수량(${row.orderedQty}${row.unit}) 이하로 입력해주세요.`);
          return;
        }

        billed.push({ productId: row.productId, qty });
      }
    }

    const result = await finalizeShipmentAction(orderId, confirmShort, billed);

    if (!result.success) {
      if (result.error === "SHIPMENT_SHORT") {
        const preview = await previewShipmentAction(orderId);
        setFinalizing(false);

        if (preview.success) {
          const rows = preview.data ?? [];

          setBilledInputs(Object.fromEntries(rows.map((row) => [row.productId, String(row.shippedQty > 0 ? row.orderedQty : 0)])));
          setConfirming(rows);
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

    // 마감한 주문서는 더 찍을 수 없다 — 다음 주문서를 저절로 골라 준다(없으면 고른 채로 두고 안내 카드가 알려 준다).
    const nextOrder = orders.find((order) => !order.finalized && order.id !== orderId) ?? null;
    const doneText = result.data?.wasShort
      ? `출고 마감. 실제 중량 기준 ${result.data.totalAmount.toLocaleString()}원으로 확정했습니다.`
      : "출고 마감했습니다.";

    setMessage(nextOrder ? `${doneText} 다음 주문서: ${nextOrder.orderNumber} · ${nextOrder.retailerName}` : doneText);

    if (nextOrder) {
      setOrderId(nextOrder.id);
    } else {
      await loadProgress(orderId);
    }

    router.refresh();
  };

  const allDone =
    progress.length > 0 && progress.every((row) => row.scannedQty >= row.orderedQty);

  const selectedOrder = orders.find((order) => order.id === orderId) ?? null;
  const guide = pickOutboundGuide({
    orderCount: orders.length,
    openOrderCount: orders.filter((order) => !order.finalized).length,
    selected: selectedOrder ? { status: selectedOrder.status, finalized: selectedOrder.finalized } : null,
    progress,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <section
        id="outbound-guide"
        style={{
          ...panelStyle,
          borderColor: guide.tone === "warn" ? "#fcd34d" : guide.tone === "done" ? "#86efac" : "#bfdbfe",
          backgroundColor: guide.tone === "warn" ? "#fffbeb" : guide.tone === "done" ? "#f0fdf4" : "#eff6ff",
        }}
      >
        <div style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>{guide.title}</div>
        <div style={{ fontSize: "12px", color: "#475569", marginTop: "4px", lineHeight: 1.5 }}>{guide.detail}</div>
        {guide.action?.kind === "finalize" && (
          <button
            type="button"
            onClick={() => void finalize(false)}
            disabled={finalizing}
            style={{
              marginTop: "10px",
              padding: "9px 14px",
              fontSize: "13px",
              fontWeight: 700,
              borderRadius: "6px",
              border: "none",
              backgroundColor: finalizing ? "#94a3b8" : "#0f172a",
              color: "#fff",
              cursor: finalizing ? "default" : "pointer",
            }}
          >
            {finalizing ? "처리 중…" : guide.action.label}
          </button>
        )}
        {guide.action?.kind === "link" && guide.action.href && (
          <Link
            href={guide.action.href}
            style={{
              display: "inline-block",
              marginTop: "10px",
              padding: "9px 14px",
              fontSize: "13px",
              fontWeight: 700,
              borderRadius: "6px",
              backgroundColor: "#0f172a",
              color: "#fff",
              textDecoration: "none",
            }}
          >
            {guide.action.label}
          </Link>
        )}
      </section>

      <section style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <label htmlFor="order" style={labelStyle}>
            주문서
          </label>
          <button
            type="button"
            onClick={() => setNewestFirst((value) => !value)}
            aria-label="주문서 정렬 순서 바꾸기"
            style={{ padding: "4px 10px", border: "1px solid #cbd5e1", borderRadius: "999px", background: "#fff", cursor: "pointer", fontSize: "12px", fontWeight: 600, color: "#334155" }}
          >
            {newestFirst ? "최신순 ↓ (눌러서 오래된 순)" : "오래된 순 ↑ (눌러서 최신순)"}
          </button>
        </div>
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
          {(newestFirst ? [...orders].sort((a, b) => Number(a.finalized) - Number(b.finalized) || b.orderedAt.localeCompare(a.orderedAt)) : orders).map((order) => (
            <option key={order.id} value={order.id}>
              {order.orderNumber} · {order.retailerName} · {formatDate(order.orderedAt)}
              {order.finalized ? " (마감됨)" : order.status === "awaiting_stock" ? " (재고 확보 대기)" : ""}
            </option>
          ))}
        </select>

        <div style={{ marginTop: "12px" }}>
          <label htmlFor="outbound-weight" style={labelStyle}>
            실제 단 중량 (kg, 선택)
          </label>
          <input
            id="outbound-weight"
            type="text"
            inputMode="decimal"
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
            disabled={!orderId || Boolean(selectedOrder?.finalized)}
            autoComplete="off"
            placeholder="잘라서 달았다면 먼저 적고, 바코드를 찍으세요"
            style={inputStyle}
          />
          <p style={{ fontSize: "11px", color: "#94a3b8", margin: "4px 0 0" }}>
            실제 중량을 적은 뒤 바코드를 찍으면, 박스 장부 잔량이 더 많을 때 박스에 고기가 남았는지 물어봅니다.
          </p>
        </div>

        {pendingChoice && (
          <div
            role="alertdialog"
            style={{ marginTop: "12px", padding: "12px", borderRadius: "10px", border: "1px solid #fcd34d", backgroundColor: "#fffbeb" }}
          >
            <div style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>
              {pendingChoice.value} 박스에 고기가 남아 있나요?
            </div>
            <div style={{ fontSize: "12px", color: "#475569", marginTop: "4px", lineHeight: 1.5 }}>
              장부에는 {pendingChoice.remaining}kg이 있는데 {pendingChoice.weight}kg을 달아 냈습니다. 고르기 전에는 출고가 기록되지 않습니다.
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
              <button type="button" onClick={() => void answerChoice(false)} style={choiceButtonStyle}>
                남아 있음 (장부 그대로)
              </button>
              <button type="button" onClick={() => void answerChoice(true)} style={choiceButtonStyle}>
                다 썼음 (나머지 {Math.round((pendingChoice.remaining - pendingChoice.weight) * 1000) / 1000}kg은 감량 처리)
              </button>
              <button type="button" onClick={() => setPendingChoice(null)} style={{ ...choiceButtonStyle, color: "#64748b" }}>
                취소
              </button>
            </div>
          </div>
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
            disabled={!orderId || Boolean(selectedOrder?.finalized)}
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
            <strong>청구 수량</strong>은 기본이 주문 수량입니다. 고객에게 실제 나간 만큼만 청구하려면 청구 수량을 고치세요.
            금액과 거래명세서는 청구 수량으로 확정됩니다. 실제 나간 중량은 따로 남습니다.
          </div>

          {confirming.every((row) => row.shippedQty <= 0) && (
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#991b1b", marginBottom: "10px" }}>
              나갈 박스가 하나도 없습니다(찍은 박스도, 자동 배정된 박스도 없음). 이대로 마감하면 금액이 0원이 됩니다. 박스를 찍으려면 "더 스캔하기"를 누르세요.
            </div>
          )}

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
                  {(() => {
                    const parsed = Number.parseFloat(billedInputs[row.productId] ?? String(row.shippedQty > 0 ? row.orderedQty : 0));
                    const billedQty = Number.isFinite(parsed) ? parsed : 0;
                    const billedAmount = Math.round(row.unitPrice * billedQty);

                    return (
                      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginTop: "6px" }}>
                        <label style={{ fontSize: "12px", color: "#475569" }}>
                          청구 수량 ({row.unit}){" "}
                          <input
                            type="text"
                            inputMode="decimal"
                            value={billedInputs[row.productId] ?? String(row.shippedQty > 0 ? row.orderedQty : 0)}
                            onChange={(event) =>
                              setBilledInputs((prev) => ({ ...prev, [row.productId]: event.target.value }))
                            }
                            style={{ ...inputStyle, width: "90px", padding: "4px 8px" }}
                          />
                        </label>
                        {short && (
                          <button
                            type="button"
                            onClick={() =>
                              setBilledInputs((prev) => ({ ...prev, [row.productId]: String(row.shippedQty) }))
                            }
                            style={{ ...choiceButtonStyle, padding: "4px 8px", fontSize: "12px" }}
                          >
                            실제 출고량으로
                          </button>
                        )}
                        <span style={{ fontSize: "12px", color: "#475569" }}>
                          {row.orderedAmount.toLocaleString()}원
                          {billedAmount !== row.orderedAmount && (
                            <>
                              {" → "}
                              <strong style={{ color: "#b45309" }}>{billedAmount.toLocaleString()}원</strong>
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })()}
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
                  {!row.alreadyPicked && (row.storageLocation || row.storageLocationPhotoPath) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", marginTop: "3px" }}>
                      {row.storageLocation && (
                        <span
                          style={{
                            fontSize: "12px",
                            fontWeight: 700,
                            backgroundColor: "#f1f5f9",
                            color: "#334155",
                            borderRadius: "4px",
                            padding: "3px 7px",
                          }}
                        >
                          📍 {row.storageLocation}
                        </span>
                      )}
                      {row.storageLocationPhotoPath && (
                        <button
                          type="button"
                          onClick={() => void handleViewLocationPhoto(row.storageLocationPhotoPath!)}
                          style={{
                            padding: "3px 8px",
                            fontSize: "11px",
                            borderRadius: "4px",
                            border: "1px solid #cbd5e1",
                            backgroundColor: "#fff",
                            color: "#334155",
                            cursor: "pointer",
                          }}
                        >
                          위치 사진 보기
                        </button>
                      )}
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

const choiceButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "13px",
  fontWeight: 700,
  borderRadius: "8px",
  border: "1px solid #cbd5e1",
  backgroundColor: "#fff",
  color: "#0f172a",
  cursor: "pointer",
};
