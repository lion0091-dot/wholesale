"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { formatOrderedAt, formatWon } from "@/lib/orders/status";
import type { RelationshipStatus } from "@/types/database";
import { CustomerCardGrid } from "./customer-card-grid";
import type { CustomerRow } from "./customer-types";

export type { CustomerRow } from "./customer-types";

type ViewMode = "card" | "table";

interface CustomerTableProps {
  customers: CustomerRow[];
  /** 미니샵 초대 링크에 사용하는 공급사 shop_token */
  shopToken: string;
  wholesalerName: string;
  /** 데모(샘플) 데이터 여부 — 실제 초대 링크가 아님을 안내한다. */
  readOnly?: boolean;
}

const RELATION_BADGES: Record<RelationshipStatus, { label: string; bg: string; color: string }> = {
  active: { label: "거래중", bg: "#dcfce7", color: "#166534" },
  blocked: { label: "거래중지", bg: "#fee2e2", color: "#991b1b" },
};

const chipButtonStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  padding: "5px 9px",
  borderRadius: "6px",
  border: "1px solid #cbd5e1",
  backgroundColor: "#ffffff",
  color: "#334155",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function buildInviteMessage(wholesalerName: string, customerName: string, shopUrl: string) {
  return `[${customerName} 사장님 전용 모바일 발주서 안내]

안녕하세요, ${wholesalerName}입니다.
${customerName} 사장님의 빠르고 편리한 육류 발주를 위해 1:1 모바일 미니샵을 준비했습니다.

아래 전용 초대 링크에서 당일 품목과 사장님께만 적용되는 맞춤 단가·마감 특가(시크릿딜)를 확인하시고 간편하게 발주서를 보내주세요!

👉 발주 링크: ${shopUrl}
(스마트폰 브라우저 메뉴에서 '홈 화면에 추가'해 두시면 매일 편리하게 주문하실 수 있습니다.)`;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export function CustomerTable({
  customers,
  shopToken,
  wholesalerName,
  readOnly = false,
}: CustomerTableProps) {
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<RelationshipStatus | "all">("all");
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [inviteTarget, setInviteTarget] = useState<CustomerRow | null>(null);
  const [copied, setCopied] = useState<"link" | "message" | null>(null);
  /** 카드 그리드에서 링크를 복사한 바이어 id (카드별 '복사됨' 표시) */
  const [copiedCardId, setCopiedCardId] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // 모달이 바뀌면 복사 완료 표시를 초기화한다.
  useEffect(() => {
    setCopied(null);
  }, [inviteTarget]);

  const normalizedKeyword = keyword.trim().toLowerCase();

  const visibleCustomers = customers.filter((customer) => {
    const matchesKeyword = normalizedKeyword
      ? customer.restaurantName.toLowerCase().includes(normalizedKeyword) ||
        customer.representativeName.toLowerCase().includes(normalizedKeyword) ||
        (customer.businessNumber ?? "").includes(normalizedKeyword)
      : true;
    const matchesStatus =
      statusFilter === "all" ? true : customer.relationStatus === statusFilter;

    return matchesKeyword && matchesStatus;
  });

  const shopUrl = `${origin}/shop/${shopToken}`;

  const handleCopy = async (kind: "link" | "message", text: string) => {
    try {
      await copyText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 3000);
    } catch {
      window.alert("복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
    }
  };

  /** 카드에서 모달을 열지 않고 바로 전용 미니샵 링크만 복사한다. */
  const handleCopyCardLink = async (customer: CustomerRow) => {
    try {
      await copyText(`${window.location.origin}/shop/${shopToken}`);
      setCopiedCardId(customer.id);
      setTimeout(() => setCopiedCardId(null), 3000);
    } catch {
      window.alert("복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
    }
  };

  return (
    <>
      <section
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: "8px",
            padding: "12px",
            borderBottom: "1px solid #e2e8f0",
            flexWrap: "wrap",
          }}
        >
          <input
            type="search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="상호 / 대표자 / 사업자번호 검색"
            style={{
              flex: "1 1 200px",
              minWidth: 0,
              padding: "8px 10px",
              fontSize: "13px",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
            }}
          />
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as RelationshipStatus | "all")
            }
            style={{
              padding: "8px 10px",
              fontSize: "13px",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
            }}
          >
            <option value="all">전체 거래 상태</option>
            <option value="active">거래중</option>
            <option value="blocked">거래중지</option>
          </select>

          {/* 카드(섬네일) / 목록 보기 전환 */}
          <div
            role="group"
            aria-label="보기 방식"
            style={{
              display: "flex",
              gap: "2px",
              padding: "2px",
              backgroundColor: "#f1f5f9",
              borderRadius: "7px",
            }}
          >
            {(
              [
                { mode: "card", label: "▦ 카드" },
                { mode: "table", label: "☰ 목록" },
              ] as Array<{ mode: ViewMode; label: string }>
            ).map((option) => (
              <button
                key={option.mode}
                type="button"
                aria-pressed={viewMode === option.mode}
                onClick={() => setViewMode(option.mode)}
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  padding: "6px 12px",
                  borderRadius: "5px",
                  border: "none",
                  cursor: "pointer",
                  backgroundColor: viewMode === option.mode ? "#ffffff" : "transparent",
                  color: viewMode === option.mode ? "#0f172a" : "#64748b",
                  boxShadow: viewMode === option.mode ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {visibleCustomers.length === 0 ? (
          <p
            style={{ padding: "40px 16px", textAlign: "center", fontSize: "13px", color: "#94a3b8" }}
          >
            조건에 맞는 고객(바이어)이 없습니다.
          </p>
        ) : viewMode === "card" ? (
          <CustomerCardGrid
            customers={visibleCustomers}
            copiedLinkId={copiedCardId}
            onCopyLink={(customer) => void handleCopyCardLink(customer)}
            onOpenInvite={setInviteTarget}
          />
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>고객사 (바이어)</th>
                  <th>사업자 정보</th>
                  <th>배송지</th>
                  <th>맞춤 단가</th>
                  <th>발주 실적</th>
                  <th>거래 상태</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {visibleCustomers.map((customer) => {
                  const relation = RELATION_BADGES[customer.relationStatus];
                  const hasCustomPrice = customer.customPriceCount > 0;

                  return (
                    <tr
                      key={customer.id}
                      style={{ opacity: customer.relationStatus === "blocked" ? 0.6 : 1 }}
                    >
                      <td>
                        <div style={{ fontWeight: 700 }}>{customer.restaurantName}</div>
                        <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                          거래 시작 {formatOrderedAt(customer.joinedAt)}
                        </div>
                        {customer.memo && (
                          <div style={{ fontSize: "11px", color: "#b45309", marginTop: "2px" }}>
                            📝 {customer.memo}
                          </div>
                        )}
                      </td>

                      <td style={{ fontSize: "12px" }}>
                        <div>대표 {customer.representativeName}</div>
                        <div style={{ color: "#64748b", marginTop: "2px" }}>
                          {customer.businessNumber ?? "사업자번호 미등록"}
                        </div>
                      </td>

                      <td style={{ fontSize: "12px", color: "#334155", minWidth: "160px" }}>
                        {customer.deliveryAddress}
                      </td>

                      <td>
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            backgroundColor: hasCustomPrice ? "#ede9fe" : "#f1f5f9",
                            color: hasCustomPrice ? "#5b21b6" : "#64748b",
                            borderRadius: "4px",
                            padding: "4px 8px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {hasCustomPrice
                            ? `🏷️ ${customer.customPriceCount}개 적용`
                            : "기본 단가"}
                        </span>
                      </td>

                      <td style={{ fontSize: "12px", whiteSpace: "nowrap" }}>
                        <div style={{ fontWeight: 700 }}>{customer.orderCount}건</div>
                        <div style={{ color: "#64748b", marginTop: "2px" }}>
                          {formatWon(customer.totalOrderAmount)}
                        </div>
                        <div style={{ color: "#94a3b8", fontSize: "11px", marginTop: "2px" }}>
                          {customer.lastOrderedAt
                            ? `최근 ${formatOrderedAt(customer.lastOrderedAt)}`
                            : "발주 이력 없음"}
                        </div>
                      </td>

                      <td>
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            backgroundColor: relation.bg,
                            color: relation.color,
                            borderRadius: "4px",
                            padding: "4px 8px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {relation.label}
                        </span>
                      </td>

                      <td>
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            type="button"
                            onClick={() => setInviteTarget(customer)}
                            style={{
                              ...chipButtonStyle,
                              backgroundColor: "#fee500",
                              borderColor: "#fde047",
                              color: "#181600",
                            }}
                          >
                            초대 링크
                          </button>
                          <Link
                            href={`/dashboard/custom-prices?retailer=${encodeURIComponent(customer.id)}`}
                            style={{ ...chipButtonStyle, display: "inline-block" }}
                          >
                            단가 설정
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 미니샵 전용 초대 링크 모달 */}
      {inviteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="미니샵 초대 링크"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            backgroundColor: "rgba(15, 23, 42, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            style={{
              backgroundColor: "#ffffff",
              borderRadius: "14px",
              padding: "20px",
              width: "100%",
              maxWidth: "520px",
              maxHeight: "88vh",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
              <div style={{ flex: 1 }}>
                <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>
                  미니샵 전용 초대 링크
                </h2>
                <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                  {inviteTarget.restaurantName} 사장님께 카카오톡으로 발송할 발주 링크입니다.
                </p>
              </div>
              <button
                type="button"
                aria-label="닫기"
                onClick={() => setInviteTarget(null)}
                style={{
                  ...chipButtonStyle,
                  border: "none",
                  background: "none",
                  fontSize: "18px",
                  padding: "0 4px",
                }}
              >
                ✕
              </button>
            </div>

            {readOnly && (
              <div
                style={{
                  backgroundColor: "#fef3c7",
                  border: "1px solid #fde68a",
                  color: "#92400e",
                  fontSize: "12px",
                  padding: "9px 11px",
                  borderRadius: "8px",
                }}
              >
                샘플 토큰으로 생성된 링크입니다. 실제 초대는 로그인 후 발급된 미니샵 토큰으로
                진행해주세요.
              </div>
            )}

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#475569",
                  marginBottom: "5px",
                }}
              >
                발주 링크
              </label>
              <div style={{ display: "flex", gap: "6px" }}>
                <input
                  readOnly
                  value={shopUrl}
                  onFocus={(event) => event.currentTarget.select()}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "9px 11px",
                    fontSize: "13px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    backgroundColor: "#f8fafc",
                    color: "#0f172a",
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleCopy("link", shopUrl)}
                  style={{
                    ...chipButtonStyle,
                    backgroundColor: copied === "link" ? "#16a34a" : "#0f172a",
                    borderColor: copied === "link" ? "#16a34a" : "#0f172a",
                    color: "#ffffff",
                    padding: "9px 13px",
                  }}
                >
                  {copied === "link" ? "✓ 복사됨" : "링크 복사"}
                </button>
              </div>
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#475569",
                  marginBottom: "5px",
                }}
              >
                카카오톡 발송 문구
              </label>
              <textarea
                readOnly
                value={buildInviteMessage(wholesalerName, inviteTarget.restaurantName, shopUrl)}
                rows={10}
                style={{
                  width: "100%",
                  padding: "10px 11px",
                  fontSize: "12px",
                  lineHeight: 1.6,
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  backgroundColor: "#f8fafc",
                  color: "#0f172a",
                  resize: "vertical",
                }}
              />
            </div>

            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <a
                href={`/shop/${shopToken}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...chipButtonStyle, display: "inline-block", padding: "9px 13px" }}
              >
                미니샵 미리보기 ↗
              </a>
              <button
                type="button"
                onClick={() =>
                  void handleCopy(
                    "message",
                    buildInviteMessage(wholesalerName, inviteTarget.restaurantName, shopUrl)
                  )
                }
                style={{
                  ...chipButtonStyle,
                  backgroundColor: copied === "message" ? "#16a34a" : "#fee500",
                  borderColor: copied === "message" ? "#16a34a" : "#fde047",
                  color: copied === "message" ? "#ffffff" : "#181600",
                  fontWeight: 700,
                  padding: "9px 13px",
                }}
              >
                {copied === "message" ? "✓ 문구 복사 완료" : "💬 카톡 문구 복사"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
