"use client";

import { useState } from "react";
import {
  updateSupplierStatusAction,
  updateSupplierSubscriptionAction,
  verifyBusinessWithNtsAction,
  getBusinessLicenseUrlAction,
} from "./actions";
import {
  formatBusinessNumber,
  resolveDocumentVerification,
  type DocumentVerificationLevel,
} from "@/lib/validation/business-number";
import type { Wholesaler, WholesalerStatus, SubscriptionStatus } from "@/types/database";

interface SupplierApprovalListProps {
  initialSuppliers: Wholesaler[];
}

interface BadgeStyle {
  label: string;
  bg: string;
  color: string;
}

const STATUS_BADGES: Record<WholesalerStatus, BadgeStyle> = {
  pending: { label: "가입 승인대기", bg: "#fef3c7", color: "#92400e" },
  active: { label: "정상 영업중", bg: "#dcfce7", color: "#166534" },
  suspended: { label: "이용 일시정지", bg: "#fee2e2", color: "#991b1b" },
  rejected: { label: "가입 거절", bg: "#f1f5f9", color: "#64748b" },
};

const SUB_BADGES: Record<SubscriptionStatus, BadgeStyle> = {
  trial: { label: "무료 체험", bg: "#e0e7ff", color: "#3730a3" },
  active: { label: "월 구독 유료", bg: "#dcfce7", color: "#166534" },
  overdue: { label: "구독료 미납", bg: "#fee2e2", color: "#991b1b" },
  cancelled: { label: "구독 해지", bg: "#f1f5f9", color: "#64748b" },
};

/** 사업자등록증 검증 상태 배지 색상 */
const DOC_BADGES: Record<DocumentVerificationLevel, { bg: string; color: string; icon: string }> = {
  verified: { bg: "#ecfdf5", color: "#047857", icon: "✔" },
  reviewing: { bg: "#eff6ff", color: "#1d4ed8", icon: "🔍" },
  invalid: { bg: "#fef2f2", color: "#b91c1c", icon: "⚠" },
  rejected: { bg: "#f1f5f9", color: "#64748b", icon: "✖" },
};

/** 국세청 진위확인 상태 배지 색상 */
const NTS_BADGES: Record<
  Wholesaler["nts_verification_status"],
  { bg: string; color: string; icon: string; label: string }
> = {
  unchecked: { bg: "#f1f5f9", color: "#64748b", icon: "•", label: "국세청 진위확인 미실행" },
  match: { bg: "#ecfdf5", color: "#047857", icon: "✔", label: "국세청 진위확인 일치" },
  mismatch: { bg: "#fef2f2", color: "#b91c1c", icon: "⚠", label: "국세청 진위확인 불일치" },
  not_found: { bg: "#fef2f2", color: "#b91c1c", icon: "⚠", label: "국세청 미등록 번호" },
  error: { bg: "#fffbeb", color: "#b45309", icon: "!", label: "국세청 API 호출 실패" },
};

const SUBSCRIPTION_OPTIONS: Array<{ value: SubscriptionStatus; label: string }> = [
  { value: "trial", label: "무료 체험 (trial)" },
  { value: "active", label: "유료 활성 (active)" },
  { value: "overdue", label: "구독료 미납 (overdue)" },
  { value: "cancelled", label: "구독 해지 (cancelled)" },
];

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function SupplierApprovalList({ initialSuppliers }: SupplierApprovalListProps) {
  const [suppliers, setSuppliers] = useState<Wholesaler[]>(initialSuppliers);
  const [activeFilter, setActiveFilter] = useState<WholesalerStatus | "all">("all");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [ntsMessage, setNtsMessage] = useState<Record<string, string>>({});

  const filtered = suppliers.filter((s) => activeFilter === "all" || s.status === activeFilter);

  const handleStatusChange = async (id: string, nextStatus: WholesalerStatus) => {
    if (nextStatus === "rejected" && !confirm("가입을 거절하면 해당 공급사는 백오피스에 접근할 수 없습니다. 진행할까요?")) {
      return;
    }

    setLoadingId(id);

    try {
      const res = await updateSupplierStatusAction(id, nextStatus);

      if (res.success) {
        setSuppliers((prev) => prev.map((s) => (s.id === id ? { ...s, status: nextStatus } : s)));
      } else {
        alert(res.error || "상태 변경에 실패했습니다.");
      }
    } catch {
      alert("오류가 발생했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const handleVerifyNts = async (id: string) => {
    setLoadingId(id);
    setNtsMessage((prev) => ({ ...prev, [id]: "" }));

    try {
      const res = await verifyBusinessWithNtsAction(id);

      if (res.success && res.status) {
        setSuppliers((prev) =>
          prev.map((s) =>
            s.id === id
              ? { ...s, nts_verification_status: res.status!, nts_verified_at: new Date().toISOString() }
              : s
          )
        );
        setNtsMessage((prev) => ({ ...prev, [id]: res.message ?? "" }));
      } else {
        alert(res.error || "국세청 진위확인에 실패했습니다.");
      }
    } catch {
      alert("오류가 발생했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const handleViewLicense = async (id: string) => {
    setLoadingId(id);

    try {
      const res = await getBusinessLicenseUrlAction(id);

      if (res.success && res.url) {
        window.open(res.url, "_blank", "noopener,noreferrer");
      } else {
        alert(res.error || "사업자등록증을 조회할 수 없습니다.");
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
      const res = await updateSupplierSubscriptionAction(id, nextSub);

      if (res.success) {
        setSuppliers((prev) =>
          prev.map((s) => (s.id === id ? { ...s, subscription_status: nextSub } : s))
        );
      } else {
        alert(res.error || "구독 상태 변경에 실패했습니다.");
      }
    } catch {
      alert("오류가 발생했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div>
      {/* 상태 필터 탭 */}
      <div style={{ display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "8px", marginBottom: "20px" }}>
        {(["all", "pending", "active", "suspended", "rejected"] as const).map((filter) => {
          const count =
            filter === "all" ? suppliers.length : suppliers.filter((s) => s.status === filter).length;
          const label = filter === "all" ? "전체" : STATUS_BADGES[filter].label;
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

      {filtered.length === 0 ? (
        <div
          style={{
            backgroundColor: "#ffffff",
            borderRadius: "12px",
            border: "1px dashed #cbd5e1",
            padding: "48px 16px",
            textAlign: "center",
            color: "#64748b",
            fontSize: "14px",
          }}
        >
          해당 상태의 공급사가 없습니다.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {filtered.map((supplier) => {
            const statusConfig = STATUS_BADGES[supplier.status] ?? STATUS_BADGES.pending;
            const subConfig = SUB_BADGES[supplier.subscription_status] ?? SUB_BADGES.trial;
            const doc = resolveDocumentVerification(supplier.business_number, supplier.status);
            const docStyle = DOC_BADGES[doc.level];
            const isBusy = loadingId === supplier.id;

            return (
              <div
                key={supplier.id}
                style={{
                  backgroundColor: "#ffffff",
                  borderRadius: "12px",
                  padding: "20px",
                  border: "1px solid #e2e8f0",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                  opacity: isBusy ? 0.6 : 1,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: "8px",
                    borderBottom: "1px solid #f1f5f9",
                    paddingBottom: "12px",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                      <h3 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>
                        {supplier.business_name}
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

                    <p style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>
                      대표자: {supplier.representative_name} | 신청일: {formatDate(supplier.created_at)}
                    </p>
                  </div>

                  <a
                    href={`/shop/${supplier.shop_token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: "12px", color: "#2563eb", fontWeight: 600, textDecoration: "underline" }}
                  >
                    미니샵 확인 ↗
                  </a>
                </div>

                {/* 사업자등록증 검증 상태 */}
                <div
                  style={{
                    marginTop: "12px",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    backgroundColor: docStyle.bg,
                    border: `1px solid ${docStyle.color}22`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        fontSize: "12px",
                        fontWeight: 700,
                        color: docStyle.color,
                      }}
                    >
                      <span>{docStyle.icon}</span>
                      <span>사업자등록증 {doc.label}</span>
                      <span style={{ fontWeight: 600, color: "#475569" }}>
                        {formatBusinessNumber(supplier.business_number)}
                      </span>
                    </div>
                    {supplier.business_license_path ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleViewLicense(supplier.id)}
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          color: "#0f172a",
                          backgroundColor: "#ffffff",
                          border: "1px solid #cbd5e1",
                          borderRadius: "6px",
                          padding: "4px 10px",
                          cursor: isBusy ? "not-allowed" : "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        📎 등록증 사본 보기
                      </button>
                    ) : (
                      <span style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 600 }}>
                        등록증 사본 미제출
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: "11px", color: "#64748b", marginTop: "4px" }}>{doc.description}</p>
                </div>

                {/* 국세청 진위확인 */}
                {(() => {
                  const ntsBadge = NTS_BADGES[supplier.nts_verification_status];

                  return (
                    <div
                      style={{
                        marginTop: "8px",
                        padding: "10px 12px",
                        borderRadius: "8px",
                        backgroundColor: ntsBadge.bg,
                        border: `1px solid ${ntsBadge.color}22`,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        flexWrap: "wrap",
                        gap: "8px",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "12px",
                            fontWeight: 700,
                            color: ntsBadge.color,
                          }}
                        >
                          <span>{ntsBadge.icon}</span>
                          <span>{ntsBadge.label}</span>
                        </div>
                        <p style={{ fontSize: "11px", color: "#64748b", marginTop: "4px" }}>
                          {ntsMessage[supplier.id] ||
                            (supplier.nts_verified_at
                              ? `마지막 확인: ${formatDate(supplier.nts_verified_at)}`
                              : "사업자번호 · 대표자명 · 개업일자를 국세청 실데이터와 대조합니다.")}
                        </p>
                        {!supplier.business_start_date && (
                          <p style={{ fontSize: "11px", color: "#b45309", marginTop: "4px" }}>
                            개업일자가 아직 제출되지 않아 실행할 수 없습니다 (공급사 제출 대기).
                          </p>
                        )}
                      </div>
                      <button
                        disabled={isBusy || !supplier.business_start_date}
                        onClick={() => handleVerifyNts(supplier.id)}
                        style={{
                          backgroundColor: "#ffffff",
                          color: "#0f172a",
                          fontSize: "12px",
                          fontWeight: 600,
                          padding: "6px 12px",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          cursor: isBusy || !supplier.business_start_date ? "not-allowed" : "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        국세청 진위확인 실행
                      </button>
                    </div>
                  );
                })()}

                {/* 승인/거절 및 구독 권한 제어 */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "8px",
                    marginTop: "16px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#475569" }}>
                    <span>서브스크립션:</span>
                    <select
                      disabled={isBusy}
                      value={supplier.subscription_status}
                      onChange={(e) =>
                        handleSubscriptionChange(supplier.id, e.target.value as SubscriptionStatus)
                      }
                      style={{
                        padding: "4px 8px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                      }}
                    >
                      {SUBSCRIPTION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: "flex", gap: "8px" }}>
                    {supplier.status === "pending" && (
                      <>
                        {(() => {
                          const canApprove =
                            doc.checksumValid &&
                            Boolean(supplier.business_license_path) &&
                            supplier.nts_verification_status === "match";

                          return (
                            <button
                              disabled={isBusy || !canApprove}
                              title={
                                canApprove
                                  ? undefined
                                  : !doc.checksumValid
                                    ? "사업자등록번호 체크섬 오류 — 승인할 수 없습니다."
                                    : !supplier.business_license_path
                                      ? "사업자등록증 사본이 제출되지 않아 승인할 수 없습니다."
                                      : "국세청 진위확인이 완료(일치)되지 않아 승인할 수 없습니다."
                              }
                              onClick={() => handleStatusChange(supplier.id, "active")}
                              style={{
                                backgroundColor: canApprove ? "#16a34a" : "#cbd5e1",
                                color: "#ffffff",
                                fontSize: "12px",
                                fontWeight: 700,
                                padding: "6px 14px",
                                borderRadius: "6px",
                                border: "none",
                                cursor: isBusy || !canApprove ? "not-allowed" : "pointer",
                              }}
                            >
                              입점 승인
                            </button>
                          );
                        })()}
                        <button
                          disabled={isBusy}
                          onClick={() => handleStatusChange(supplier.id, "rejected")}
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
                          가입 거절
                        </button>
                      </>
                    )}

                    {supplier.status === "active" && (
                      <button
                        disabled={isBusy}
                        onClick={() => handleStatusChange(supplier.id, "suspended")}
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

                    {(supplier.status === "suspended" || supplier.status === "rejected") && (
                      <button
                        disabled={isBusy}
                        onClick={() => handleStatusChange(supplier.id, "active")}
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
                        {supplier.status === "suspended" ? "정지 해제 (영업 재개)" : "거절 철회 (승인)"}
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
