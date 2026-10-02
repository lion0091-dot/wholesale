"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createPurchaseOrderFromUnlistedScanAction } from "../actions";

export interface HoldItem {
  scanId: string;
  traceNo: string;
  weight: number;
  poState: "UNLISTED_HELD" | "OVER_HELD";
  createdAt: string;
  productId: string | null;
  productName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  /** 발주서에 아직 안 붙은 무게(kg) — UNLISTED_HELD는 전체, OVER_HELD는 넘친 만큼만. */
  unassignedWeight: number;
}

export interface RejectionItem {
  id: string;
  traceNo: string;
  weight: number;
  reason: "OVER" | "UNLISTED";
  createdAt: string;
  productName: string | null;
  supplierName: string | null;
}

interface Props {
  holds: HoldItem[];
  rejections: RejectionItem[];
  canManage: boolean;
}

const HOLD_BADGE: Record<HoldItem["poState"], { label: string; bg: string; color: string }> = {
  UNLISTED_HELD: { label: "전표에 없음", bg: "#fef3c7", color: "#92400e" },
  OVER_HELD: { label: "발주 수량 초과", bg: "#fef3c7", color: "#92400e" },
};

function formatKg(value: number): string {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 3 });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const panelStyle: React.CSSProperties = { border: "1px solid #e2e8f0", borderRadius: "12px", backgroundColor: "#fff", padding: "14px" };
const rowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "10px",
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  fontSize: "13px",
};
const primaryButton: React.CSSProperties = {
  border: "none",
  borderRadius: "8px",
  backgroundColor: "#0f172a",
  color: "#fff",
  fontSize: "13px",
  fontWeight: 700,
  padding: "8px 14px",
  cursor: "pointer",
  marginLeft: "auto",
};

export function HoldsView({ holds, rejections, canManage }: Props) {
  const router = useRouter();
  const [busyScanId, setBusyScanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleCreate = async (item: HoldItem) => {
    setBusyScanId(item.scanId);
    setError(null);
    setNotice(null);

    const result = await createPurchaseOrderFromUnlistedScanAction(item.scanId);

    setBusyScanId(null);

    if (!result.success) {
      setError(result.error ?? "처리하지 못했습니다.");
      return;
    }

    setNotice(
      `전표를 만들었습니다 (${formatKg(result.data!.amount)}kg). 전표관리에서 확인할 수 있습니다.`
    );
    router.refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {error && (
        <p style={{ margin: 0, padding: "10px 12px", fontSize: "13px", color: "#991b1b", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px" }}>
          {error}
        </p>
      )}
      {notice && (
        <p style={{ margin: 0, padding: "10px 12px", fontSize: "13px", color: "#065f46", backgroundColor: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "8px" }}>
          {notice}
        </p>
      )}

      <section style={panelStyle}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
          대기 중인 물건 ({holds.length}개)
        </div>

        {holds.length === 0 ? (
          <p style={{ margin: 0, fontSize: "13px", color: "#94a3b8" }}>대기 중인 물건이 없습니다.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {holds.map((item) => {
              const badge = HOLD_BADGE[item.poState];

              return (
                <div key={item.scanId} id={`hold-${item.scanId}`} style={{ ...rowStyle, scrollMarginTop: "12px" }}>
                  <span style={{ fontFamily: "monospace" }}>{item.traceNo}</span>
                  <span style={{ fontWeight: 700 }}>{item.productName ?? "상품 미지정"}</span>
                  <span style={{ color: "#64748b" }}>{item.supplierName ?? "거래처 미상"}</span>
                  <span
                    style={{ fontSize: "11px", fontWeight: 700, backgroundColor: badge.bg, color: badge.color, borderRadius: "4px", padding: "2px 8px" }}
                  >
                    {badge.label}
                  </span>
                  <span style={{ color: "#334155" }}>
                    {item.poState === "OVER_HELD"
                      ? `전체 ${formatKg(item.weight)}kg 중 전표에 못 붙은 ${formatKg(item.unassignedWeight)}kg`
                      : `${formatKg(item.weight)}kg`}
                  </span>
                  <span style={{ color: "#94a3b8", fontSize: "12px" }}>{formatDateTime(item.createdAt)}</span>

                  {canManage && item.productId && item.unassignedWeight > 0 && (
                    <button type="button" style={primaryButton} disabled={busyScanId === item.scanId} onClick={() => void handleCreate(item)}>
                      {busyScanId === item.scanId ? "만드는 중…" : "전표 추가 생성"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!canManage && holds.length > 0 && (
          <p style={{ margin: "10px 0 0", fontSize: "12px", color: "#64748b" }}>
            전표 추가 생성은 대표님과 전표 담당 직원만 할 수 있습니다.
          </p>
        )}
      </section>

      <section style={panelStyle}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
          받지 않은 물건(최근 {rejections.length}건)
        </div>

        {rejections.length === 0 ? (
          <p style={{ margin: 0, fontSize: "13px", color: "#94a3b8" }}>받지 않은 물건이 없습니다.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {rejections.map((item) => (
              <div key={item.id} style={{ ...rowStyle, fontSize: "12px", color: "#64748b" }}>
                <span style={{ fontFamily: "monospace" }}>{item.traceNo}</span>
                <span>{item.productName ?? "상품 미상"}</span>
                <span>{item.supplierName ?? "거래처 미상"}</span>
                <span>{formatKg(item.weight)}kg</span>
                <span style={{ color: "#991b1b" }}>{item.reason === "OVER" ? "발주 수량 초과로 거절" : "전표에 없어 거절"}</span>
                <span style={{ marginLeft: "auto" }}>{formatDateTime(item.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
