"use client";

/**
 * 고객(단골 바이어) 카드 그리드.
 *
 * 도매 사장님이 거래처를 한눈에 훑을 수 있도록 섬네일(이니셜 아바타) + 핵심 정보를
 * 카드로 묶어 보여준다. 카드마다 다음 액션을 1클릭으로 제공한다.
 * - 전용 미니샵 초대장(링크 + 카톡 문구 + 미리보기) 모달 열기
 * - 해당 바이어가 선택된 상태로 맞춤 단가 설정 화면 이동
 */

import Link from "next/link";
import type { CSSProperties } from "react";
import { formatOrderedAt, formatWon } from "@/lib/orders/status";
import { SampleBadge } from "@/components/sample-badge";
import { IncompleteProfileBadge } from "@/components/incomplete-profile-badge";
import type { RelationshipStatus } from "@/types/database";
import type { CustomerRow } from "./customer-types";

interface CustomerCardGridProps {
  customers: CustomerRow[];
  /** 초대장 발부 권한 — 미승인 공급사는 버튼이 잠긴다. */
  canIssueInvite: boolean;
  /** 링크 / 카톡 문구 / 미니샵 미리보기가 담긴 초대 모달 열기 */
  onOpenInvite: (customer: CustomerRow) => void;
  /** 여신 한도 수정 모달 열기 */
  onOpenCredit: (customer: CustomerRow) => void;
  /** 거래중지 / 거래 재개 모달 열기 */
  onOpenStatus: (customer: CustomerRow) => void;
  /** 샘플(데모) 고객 목록 여부 — 카드마다 "샘플" 배지를 붙인다. */
  isDemo?: boolean;
}

const RELATION_BADGES: Record<RelationshipStatus, { label: string; bg: string; color: string }> = {
  active: { label: "거래중", bg: "#dcfce7", color: "#166534" },
  blocked: { label: "거래중지", bg: "#fee2e2", color: "#991b1b" },
};

/** 섬네일 아바타 색상 — 상호명 해시로 고정해 매 렌더 동일한 색을 유지한다. */
const AVATAR_COLORS = [
  { bg: "#dbeafe", color: "#1d4ed8" },
  { bg: "#fee2e2", color: "#b91c1c" },
  { bg: "#dcfce7", color: "#15803d" },
  { bg: "#ede9fe", color: "#6d28d9" },
  { bg: "#ffedd5", color: "#c2410c" },
  { bg: "#cffafe", color: "#0e7490" },
];

function avatarPalette(name: string) {
  let hash = 0;

  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 100000;
  }

  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** 상호에서 괄호 설명·공백을 걷어내고 앞 두 글자를 섬네일 이니셜로 쓴다. */
function avatarInitials(name: string) {
  const cleaned = name.replace(/\([^)]*\)/g, "").trim();

  return (cleaned || name).slice(0, 2);
}

const cardStyle: CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "14px",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

const badgeStyle: CSSProperties = {
  fontSize: "11px",
  fontWeight: 700,
  borderRadius: "4px",
  padding: "3px 7px",
  whiteSpace: "nowrap",
};

const actionStyle: CSSProperties = {
  flex: "1 1 0",
  fontSize: "12px",
  fontWeight: 700,
  padding: "8px 10px",
  borderRadius: "7px",
  border: "1px solid #cbd5e1",
  textAlign: "center",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: "10px", fontWeight: 700, color: "#94a3b8" }}>{label}</div>
      <div style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a", marginTop: "2px" }}>
        {value}
      </div>
    </div>
  );
}

export function CustomerCardGrid({
  customers,
  canIssueInvite,
  onOpenInvite,
  onOpenCredit,
  onOpenStatus,
  isDemo = false,
}: CustomerCardGridProps) {
  return (
    <div className="dash-customer-grid">
      {customers.map((customer) => {
        const relation = RELATION_BADGES[customer.relationStatus];
        const hasCustomPrice = customer.customPriceCount > 0;
        const palette = avatarPalette(customer.restaurantName);

        return (
          <article
            key={customer.id}
            style={{
              ...cardStyle,
              borderColor: customer.relationStatus === "blocked" ? "#fecaca" : "#e2e8f0",
              opacity: customer.relationStatus === "blocked" ? 0.75 : 1,
            }}
          >
            {/* 섬네일 + 식당명 + 담당자 */}
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <div
                aria-hidden
                style={{
                  width: "44px",
                  height: "44px",
                  flexShrink: 0,
                  borderRadius: "10px",
                  backgroundColor: palette.bg,
                  color: palette.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "15px",
                  fontWeight: 800,
                }}
              >
                {avatarInitials(customer.restaurantName)}
              </div>

              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <h3
                    style={{
                      fontSize: "14px",
                      fontWeight: 800,
                      color: "#0f172a",
                      wordBreak: "keep-all",
                    }}
                  >
                    {customer.restaurantName}
                  </h3>
                  {isDemo && <SampleBadge />}
                  {customer.hasIncompleteProfile && <IncompleteProfileBadge />}
                </div>
                <p style={{ fontSize: "12px", color: "#475569", marginTop: "3px" }}>
                  담당자 {customer.representativeName}
                </p>
                <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                  {customer.businessNumber ?? "사업자번호 미등록"}
                </p>
              </div>
            </div>

            {/* 거래 상태 / 맞춤 단가 배지 */}
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <span style={{ ...badgeStyle, backgroundColor: relation.bg, color: relation.color }}>
                {relation.label}
              </span>
              <span
                style={{
                  ...badgeStyle,
                  backgroundColor: hasCustomPrice ? "#ede9fe" : "#f1f5f9",
                  color: hasCustomPrice ? "#5b21b6" : "#64748b",
                }}
              >
                {hasCustomPrice ? `🏷️ 맞춤 단가 ${customer.customPriceCount}개` : "기본 단가 적용"}
              </span>
              {customer.creditLimit > 0 && (
                <span style={{ ...badgeStyle, backgroundColor: "#fef3c7", color: "#92400e" }}>
                  💳 한도 {formatWon(customer.creditLimit)} / 미수금 {formatWon(customer.outstandingBalance)}
                </span>
              )}
            </div>

            <p
              style={{
                fontSize: "11px",
                color: "#64748b",
                lineHeight: 1.5,
                backgroundColor: "#f8fafc",
                borderRadius: "7px",
                padding: "7px 9px",
              }}
            >
              📍 {customer.deliveryAddress}
              {customer.memo && (
                <>
                  <br />
                  <span style={{ color: "#b45309" }}>📝 {customer.memo}</span>
                </>
              )}
            </p>

            {/* 발주 실적 요약 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: "6px",
                paddingTop: "8px",
                borderTop: "1px solid #f1f5f9",
              }}
            >
              <StatCell label="누적 발주" value={`${customer.orderCount}건`} />
              <StatCell label="누적 금액" value={formatWon(customer.totalOrderAmount)} />
              <StatCell
                label="최근 발주"
                value={
                  customer.lastOrderedAt ? formatOrderedAt(customer.lastOrderedAt) : "이력 없음"
                }
              />
            </div>

            {/* 카드 액션 — 초대장 보기 / 맞춤 단가 설정 */}
            <div style={{ display: "flex", gap: "6px", marginTop: "auto" }}>
              <button
                type="button"
                onClick={() => onOpenInvite(customer)}
                disabled={!canIssueInvite}
                title={canIssueInvite ? undefined : "승인 완료 후 초대장 발부가 활성화됩니다."}
                style={{
                  ...actionStyle,
                  backgroundColor: !canIssueInvite ? "#f1f5f9" : "#fee500",
                  borderColor: !canIssueInvite ? "#e2e8f0" : "#fde047",
                  color: !canIssueInvite ? "#94a3b8" : "#181600",
                  cursor: canIssueInvite ? "pointer" : "not-allowed",
                }}
              >
                {!canIssueInvite ? "🔒 승인 후 발부" : "🗂️ 초대장 보기"}
              </button>

              <Link
                href={`/dashboard/custom-prices?retailer=${encodeURIComponent(customer.id)}`}
                style={{
                  ...actionStyle,
                  backgroundColor: "#ffffff",
                  color: "#5b21b6",
                  borderColor: "#ddd6fe",
                  textDecoration: "none",
                }}
              >
                🏷️ 맞춤 단가 설정
              </Link>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button
                type="button"
                onClick={() => onOpenCredit(customer)}
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#2563eb",
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                여신 한도 수정 →
              </button>
              <button
                type="button"
                onClick={() => onOpenStatus(customer)}
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  color: customer.relationStatus === "blocked" ? "#166534" : "#991b1b",
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  textAlign: "right",
                }}
              >
                {customer.relationStatus === "blocked" ? "거래 재개 →" : "거래중지 →"}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
