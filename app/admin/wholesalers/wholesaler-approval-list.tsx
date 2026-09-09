"use client";

import { useState } from "react";
import { updateWholesalerStatusAction, updateWholesalerSubscriptionAction } from "./actions";
import type { Wholesaler, WholesalerStatus, SubscriptionStatus } from "@/types/database";

interface WholesalerApprovalListProps {
  initialWholesalers: Wholesaler[];
}

const STATUS_BADGES: Record<WholesalerStatus, { label: string; bg: string; color: string }> = {
  pending: { label: "가입 승인대기", bg: "#fef3c7", color: "#92400e" },
  active: { label: "정상 영업중", bg: "#dcfce7", color: "#166534" },
  suspended: { label: "이용 일시정지", bg: "#fee2e2", color: "#991b1b" },
  rejected: { label: "가입 반려", bg: "#f1f5f9", color: "#64748b" },
};

const SUB_BADGES: Record<SubscriptionStatus, { label: string; bg: string; color: string }> = {
  trial: { label: "무료 체험", bg: "#e0e7ff", color: "#3730a3" },
  active: { label: "월 구독 유료", bg: "#dcfce7", color: "#166534" },
  overdue: { label: "구독료 미납", bg: "#fee2e2", color: "#991b1b" },
  cancelled: { label: "구독 해지", bg: "#f1f5f9", color: "#64748b" },
};

export function WholesalerApprovalList({ initialWholesalers }: WholesalerApprovalListProps) {
  const [wholesalers, setWholesalers] = useState<Wholesaler[]>(initialWholesalers);
  const [activeFilter, setActiveFilter] = useState<WholesalerStatus | "all">("all");
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const filtered = wholesalers.filter((w) => {
    if (activeFilter === "all") return true;
    return w.status === activeFilter;
  });

  const handleStatusChange = async (id: string, nextStatus: WholesalerStatus) => {
    setLoadingId(id);
    try {
      const res = await updateWholesalerStatusAction(id, nextStatus);
      if (res.success) {
        setWholesalers((prev) =>
          prev.map((w) => (w.id === id ? { ...w, status: nextStatus } : w))
        );
      } else {
        alert(res.error || "상태 변경 실패");
      }
    } catch {
      alert("오류가 발생했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const handleSubscriptionChange = async (id: string, nextSub: SubscriptionStatus) => {
    setLoadingId(id);
    try {
      const res = await updateWholesalerSubscriptionAction(id, nextSub);
      if (res.success) {
        setWholesalers((prev) =>
          prev.map((w) => (w.id === id ? { ...w, subscription_status: nextSub } : w))
        );
      } else {
        alert(res.error || "구독 상태 변경 실패");
      }
    } catch {
      alert("오류가 발생했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div>
      {/* 필터 탭 */}
      <div style={{ display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "8px", marginBottom: "20px" }}>
        {(["all", "pending", "active", "suspended", "rejected"] as const).map((filter) => {
          const count = filter === "all" ? wholesalers.length : wholesalers.filter((w) => w.status === filter).length;
          const label = filter === "all" ? "전체" : STATUS_BADGES[filter]?.label;
          const isSelected = activeFilter === filter;

          return (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              style={{
                padding: "8px 16px",
                borderRadius: "20px",
                fontSize: "13px",
                fontWeight: isSelected ? 700 : 500,
                border: isSelected ? "1px solid #0f172a" : "1px solid #e2e8f0",
                backgroundColor: isSelected ? "#0f172a" : "#ffffff",
                color: isSelected ? "#ffffff" : "#475569",
                cursor: "pointer",
                whiteSpace: "nowrap",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span>{label}</span>
              <span
                style={{
                  fontSize: "11px",
                  padding: "1px 6px",
                  borderRadius: "10px",
                  backgroundColor: isSelected ? "#334155" : "#f1f5f9",
                  color: isSelected ? "#f8fafc" : "#64748b",
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 목록 카드 */}
      {filtered.length === 0 ? (
        <div
          style={{
            backgroundColor: "#ffffff",
            borderRadius: "12px",
            border: "1px dashed #cbd5e1",
            padding: "48px 16px",
            textAlign: "center",
            color: "#64748b",
          }}
        >
          해당 상태의 도매업체가 없습니다.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {filtered.map((wholesaler) => {
            const statusConfig = STATUS_BADGES[wholesaler.status] || STATUS_BADGES.pending;
            const subConfig = SUB_BADGES[wholesaler.subscription_status] || SUB_BADGES.trial;
            const isBusy = loadingId === wholesaler.id;

            return (
              <div
                key={wholesaler.id}
                style={{
                  backgroundColor: "#ffffff",
                  borderRadius: "12px",
                  padding: "20px",
                  border: "1px solid #e2e8f0",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "8px", borderBottom: "1px solid #f1f5f9", paddingBottom: "12px" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <h3 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>
                        {wholesaler.business_name}
                      </h3>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: "6px",
                          backgroundColor: statusConfig.bg,
                          color: statusConfig.color,
                        }}
                      >
                        {statusConfig.label}
                      </span>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: "6px",
                          backgroundColor: subConfig.bg,
                          color: subConfig.color,
                        }}
                      >
                        {subConfig.label}
                      </span>
                    </div>

                    <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                      대표자: {wholesaler.representative_name} | 사업자등록번호: {wholesaler.business_number}
                    </p>
                  </div>

                  <div>
                    <a
                      href={`/shop/${wholesaler.shop_token}`}
                      target="_blank"
                      style={{
                        fontSize: "12px",
                        color: "#2563eb",
                        fontWeight: 600,
                        textDecoration: "underline",
                      }}
                    >
                      미니샵 확인 ↗
                    </a>
                  </div>
                </div>

                {/* 제어 버튼 영역 */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginTop: "16px" }}>
                  {/* 구독 상태 변경 드롭다운 */}
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#475569" }}>
                    <span>월 구독 관리:</span>
                    <select
                      disabled={isBusy}
                      value={wholesaler.subscription_status}
                      onChange={(e) => handleSubscriptionChange(wholesaler.id, e.target.value as SubscriptionStatus)}
                      style={{ padding: "4px 8px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12px" }}
                    >
                      <option value="trial">무료 체험 (trial)</option>
                      <option value="active">유료 활성 (active - 15만원/월)</option>
                      <option value="overdue">구독료 미납 (overdue)</option>
                      <option value="cancelled">구독 해지 (cancelled)</option>
                    </select>
                  </div>

                  {/* 계정 승인/반려/정지 버튼 */}
                  <div style={{ display: "flex", gap: "8px" }}>
                    {wholesaler.status === "pending" && (
                      <>
                        <button
                          disabled={isBusy}
                          onClick={() => handleStatusChange(wholesaler.id, "active")}
                          style={{
                            backgroundColor: "#16a34a",
                            color: "#ffffff",
                            fontSize: "12px",
                            fontWeight: 700,
                            padding: "6px 14px",
                            borderRadius: "6px",
                            border: "none",
                            cursor: isBusy ? "not-allowed" : "pointer",
                          }}
                        >
                          사업자 승인
                        </button>
                        <button
                          disabled={isBusy}
                          onClick={() => handleStatusChange(wholesaler.id, "rejected")}
                          style={{
                            backgroundColor: "#ffffff",
                            color: "#dc2626",
                            fontSize: "12px",
                            fontWeight: 600,
                            padding: "6px 14px",
                            borderRadius: "6px",
                            border: "1px solid #fca5a5",
                            cursor: isBusy ? "not-allowed" : "pointer",
                          }}
                        >
                          가입 반려
                        </button>
                      </>
                    )}

                    {wholesaler.status === "active" && (
                      <button
                        disabled={isBusy}
                        onClick={() => handleStatusChange(wholesaler.id, "suspended")}
                        style={{
                          backgroundColor: "#ffffff",
                          color: "#b91c1c",
                          fontSize: "12px",
                          fontWeight: 600,
                          padding: "6px 12px",
                          borderRadius: "6px",
                          border: "1px solid #fca5a5",
                          cursor: isBusy ? "not-allowed" : "pointer",
                        }}
                      >
                        이용 일시정지
                      </button>
                    )}

                    {wholesaler.status === "suspended" && (
                      <button
                        disabled={isBusy}
                        onClick={() => handleStatusChange(wholesaler.id, "active")}
                        style={{
                          backgroundColor: "#0f172a",
                          color: "#ffffff",
                          fontSize: "12px",
                          fontWeight: 600,
                          padding: "6px 12px",
                          borderRadius: "6px",
                          border: "none",
                          cursor: isBusy ? "not-allowed" : "pointer",
                        }}
                      >
                        정지 해제 (영업 재개)
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
