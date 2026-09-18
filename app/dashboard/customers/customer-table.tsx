"use client";

import { useEffect, useState, useTransition, type CSSProperties } from "react";
import Link from "next/link";
import { issueInviteAction, type IssuedInvite } from "@/app/actions/invite";
import { formatOrderedAt, formatWon } from "@/lib/orders/status";
import { SampleBadge } from "@/components/sample-badge";
import type { RelationshipStatus } from "@/types/database";
import { CustomerCardGrid } from "./customer-card-grid";
import { updateCreditLimitAction } from "./actions";
import type { CustomerRow } from "./customer-types";

export type { CustomerRow } from "./customer-types";

type ViewMode = "card" | "table";

interface CustomerTableProps {
  customers: CustomerRow[];
  /**
   * 미니샵 미리보기 링크용 shop_token.
   * 승인된 공급사에게만 전달되며(미승인은 null), 초대 문구/링크 생성은
   * 항상 서버 액션(issueInviteAction)이 수행한다.
   */
  shopToken: string | null;
  /** 초대장 발부 권한 (미승인 공급사는 false) */
  canIssueInvite: boolean;
  /** 발부가 막힌 사유 */
  inviteRestriction?: string | null;
  /** 데모(샘플) 데이터 여부 — 실제 초대 링크가 아님을 안내한다. */
  readOnly?: boolean;
  /** 공급사 자신의 PG(토스페이먼츠) 연동 설정 여부 — 미설정이면 PG 체크박스를 잠근다. */
  pgConfigured?: boolean;
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
  canIssueInvite,
  inviteRestriction,
  readOnly = false,
  pgConfigured = false,
}: CustomerTableProps) {
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<RelationshipStatus | "all">("all");
  const [viewMode, setViewMode] = useState<ViewMode>("card");

  // 목록 뷰 전환 버튼은 좁은 화면(카톡 인앱 브라우저 등)에서 CSS로 숨겨지므로,
  // 넓은 화면에서 목록 뷰를 켜둔 채 창을 좁히거나 좁은 화면으로 페이지가 복원되는
  // 경우에도 가로 스크롤 테이블이 남지 않도록 강제로 카드 뷰로 되돌린다.
  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");

    const syncViewMode = (isNarrow: boolean) => {
      if (isNarrow) {
        setViewMode("card");
      }
    };

    syncViewMode(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => syncViewMode(event.matches);

    mediaQuery.addEventListener("change", handleChange);

    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);
  const [inviteTarget, setInviteTarget] = useState<CustomerRow | null>(null);
  const [copied, setCopied] = useState<"link" | "message" | null>(null);
  /** 서버에서 발부받은 초대장 (링크 + 카톡 문구) */
  const [invite, setInvite] = useState<IssuedInvite | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [creditTarget, setCreditTarget] = useState<CustomerRow | null>(null);
  const [creditValue, setCreditValue] = useState("");
  const [dueDaysValue, setDueDaysValue] = useState("");
  const [paymentMethodsValue, setPaymentMethodsValue] = useState<string[]>(["prepaid"]);
  const [creditError, setCreditError] = useState<string | null>(null);
  const [creditPending, startCreditTransition] = useTransition();

  // 모달을 열 때마다 해당 바이어 전용 문구를 서버에서 새로 발부받는다.
  // (shop_token 은 미승인 상태에서 클라이언트로 내려오지 않으므로 문구를 조립할 수 없다)
  useEffect(() => {
    setCopied(null);
    setInvite(null);
    setInviteError(null);

    if (!inviteTarget || !canIssueInvite) {
      return;
    }

    let active = true;

    void issueInviteAction(inviteTarget.restaurantName).then((result) => {
      if (!active) {
        return;
      }

      if (result.success && result.data) {
        setInvite(result.data);
      } else {
        setInviteError(result.error ?? "초대장을 생성할 수 없습니다.");
      }
    });

    return () => {
      active = false;
    };
  }, [inviteTarget, canIssueInvite]);

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

  /** 모바일 전용 — 기본 문자 앱을 열어 거래처 번호+초대 문구를 채워둔다(비용 0원, 오발송 없음). */
  const handleSendSms = () => {
    if (!invite || !inviteTarget?.contactPhone) {
      return;
    }

    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const separator = isIOS ? "&" : "?";
    const digits = inviteTarget.contactPhone.replace(/[^0-9+]/g, "");

    window.location.href = `sms:${digits}${separator}body=${encodeURIComponent(invite.message)}`;
  };

  const handleCopy = async (kind: "link" | "message", text: string) => {
    try {
      await copyText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 3000);
    } catch {
      window.alert("복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
    }
  };

  /** 미승인 상태에서는 모달을 열지 않고 사유만 알린다. */
  const handleOpenInvite = (customer: CustomerRow) => {
    if (!canIssueInvite) {
      window.alert(inviteRestriction ?? "승인 완료 후 초대장 발부가 활성화됩니다.");
      return;
    }

    setInviteTarget(customer);
  };

  const handleOpenCredit = (customer: CustomerRow) => {
    setCreditError(null);
    setCreditValue(String(customer.creditLimit));
    setDueDaysValue(String(customer.settlementDueDays));
    setPaymentMethodsValue(
      customer.allowedPaymentMethods.length > 0 ? customer.allowedPaymentMethods : ["prepaid"]
    );
    setCreditTarget(customer);
  };

  const togglePaymentMethod = (method: string) => {
    setPaymentMethodsValue((current) =>
      current.includes(method) ? current.filter((m) => m !== method) : [...current, method]
    );
  };

  const handleSaveCredit = () => {
    if (!creditTarget || readOnly) {
      return;
    }

    const parsedCredit = Number(creditValue);
    const parsedDueDays = Number(dueDaysValue);

    if (!Number.isFinite(parsedCredit) || parsedCredit < 0) {
      setCreditError("여신 한도는 0 이상의 숫자를 입력해주세요.");
      return;
    }

    if (!Number.isFinite(parsedDueDays) || parsedDueDays <= 0) {
      setCreditError("연체 기준일은 1 이상의 숫자를 입력해주세요.");
      return;
    }

    if (paymentMethodsValue.length === 0) {
      setCreditError("허용할 결제수단을 하나 이상 선택해주세요.");
      return;
    }

    setCreditError(null);

    startCreditTransition(async () => {
      const result = await updateCreditLimitAction(
        creditTarget.id,
        parsedCredit,
        parsedDueDays,
        paymentMethodsValue
      );

      if (result.success) {
        setCreditTarget(null);
      } else {
        setCreditError(result.error ?? "여신 한도 저장에 실패했습니다.");
      }
    });
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

          {/* 카드(섬네일) / 목록 보기 전환 — 좁은 화면(카톡 인앱 브라우저 등)에서는
              가로 스크롤이 필요한 목록 뷰 대신 항상 카드 뷰만 쓰도록 전환 버튼 자체를 숨긴다. */}
          <div
            role="group"
            aria-label="보기 방식"
            className="dash-view-toggle"
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
            조건에 맞는 고객(소매)이 없습니다.
          </p>
        ) : viewMode === "card" ? (
          <CustomerCardGrid
            customers={visibleCustomers}
            canIssueInvite={canIssueInvite}
            onOpenInvite={handleOpenInvite}
            onOpenCredit={handleOpenCredit}
            isDemo={readOnly}
          />
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>고객사 (소매)</th>
                  <th>사업자 정보</th>
                  <th>배송지</th>
                  <th>맞춤 단가</th>
                  <th>발주 실적</th>
                  <th>여신 한도</th>
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
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <div style={{ fontWeight: 700 }}>{customer.restaurantName}</div>
                          {readOnly && <SampleBadge />}
                        </div>
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

                      <td style={{ fontSize: "12px", whiteSpace: "nowrap" }}>
                        {customer.creditLimit > 0 ? (
                          <>
                            <div style={{ fontWeight: 700 }}>{formatWon(customer.creditLimit)}</div>
                            <div style={{ color: "#94a3b8", marginTop: "2px" }}>
                              미수금 {formatWon(customer.outstandingBalance)}
                            </div>
                          </>
                        ) : (
                          <span style={{ color: "#94a3b8" }}>외상 미설정</span>
                        )}
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
                            onClick={() => handleOpenCredit(customer)}
                            style={chipButtonStyle}
                          >
                            결제 설정
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenInvite(customer)}
                            disabled={!canIssueInvite}
                            title={canIssueInvite ? undefined : (inviteRestriction ?? undefined)}
                            style={{
                              ...chipButtonStyle,
                              backgroundColor: canIssueInvite ? "#fee500" : "#f1f5f9",
                              borderColor: canIssueInvite ? "#fde047" : "#e2e8f0",
                              color: canIssueInvite ? "#181600" : "#94a3b8",
                              cursor: canIssueInvite ? "pointer" : "not-allowed",
                            }}
                          >
                            {canIssueInvite ? "초대 링크" : "🔒 초대 링크"}
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

            {inviteError && (
              <div
                role="alert"
                style={{
                  backgroundColor: "#fee2e2",
                  border: "1px solid #fecaca",
                  color: "#991b1b",
                  fontSize: "12px",
                  padding: "9px 11px",
                  borderRadius: "8px",
                  lineHeight: 1.6,
                }}
              >
                {inviteError}
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
                  value={invite?.shopUrl ?? (inviteError ? "" : "초대장 발부 중...")}
                  onFocus={(event) => event.currentTarget.select()}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "9px 11px",
                    fontSize: "13px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    backgroundColor: "#f8fafc",
                    color: invite ? "#0f172a" : "#94a3b8",
                  }}
                />
                <button
                  type="button"
                  disabled={!invite}
                  onClick={() => invite && void handleCopy("link", invite.shopUrl)}
                  style={{
                    ...chipButtonStyle,
                    backgroundColor: !invite ? "#94a3b8" : copied === "link" ? "#16a34a" : "#0f172a",
                    borderColor: !invite ? "#94a3b8" : copied === "link" ? "#16a34a" : "#0f172a",
                    color: "#ffffff",
                    padding: "9px 13px",
                    cursor: invite ? "pointer" : "not-allowed",
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
                value={invite?.message ?? ""}
                placeholder="초대장 문구를 불러오는 중입니다..."
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
              {shopToken && (
                <a
                  href={`/shop/${shopToken}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ ...chipButtonStyle, display: "inline-block", padding: "9px 13px" }}
                >
                  미니샵 미리보기 ↗
                </a>
              )}
              <button
                type="button"
                disabled={!invite}
                onClick={() => invite && void handleCopy("message", invite.message)}
                style={{
                  ...chipButtonStyle,
                  backgroundColor: !invite ? "#f1f5f9" : copied === "message" ? "#16a34a" : "#fee500",
                  borderColor: !invite ? "#e2e8f0" : copied === "message" ? "#16a34a" : "#fde047",
                  color: !invite ? "#94a3b8" : copied === "message" ? "#ffffff" : "#181600",
                  fontWeight: 700,
                  padding: "9px 13px",
                  cursor: invite ? "pointer" : "not-allowed",
                }}
              >
                {copied === "message" ? "✓ 문구 복사 완료" : "💬 카톡 문구 복사"}
              </button>
              {inviteTarget.contactPhone && (
                <button
                  type="button"
                  className="dash-mobile-only"
                  disabled={!invite}
                  onClick={handleSendSms}
                  style={{
                    ...chipButtonStyle,
                    backgroundColor: !invite ? "#f1f5f9" : "#0f172a",
                    borderColor: !invite ? "#e2e8f0" : "#0f172a",
                    color: !invite ? "#94a3b8" : "#ffffff",
                    fontWeight: 700,
                    padding: "9px 13px",
                    cursor: invite ? "pointer" : "not-allowed",
                  }}
                >
                  📱 문자로 바로 보내기
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 여신 한도 수정 모달 */}
      {creditTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="결제 설정 수정"
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
              maxWidth: "400px",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
              <div style={{ flex: 1 }}>
                <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>
                  결제 설정 수정
                </h2>
                <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                  {creditTarget.restaurantName} — 현재 미수금 {formatWon(creditTarget.outstandingBalance)}
                </p>
              </div>
              <button
                type="button"
                aria-label="닫기"
                onClick={() => setCreditTarget(null)}
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
                샘플 데이터입니다. 로그인 후 실제 거래처에서 이용해주세요.
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
                여신 한도 (원)
              </label>
              <input
                type="number"
                min={0}
                step={10000}
                value={creditValue}
                onChange={(event) => setCreditValue(event.target.value)}
                style={{
                  width: "100%",
                  padding: "9px 11px",
                  fontSize: "14px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                }}
              />
              <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>
                0으로 설정하면 이 거래처는 외상 주문을 선택할 수 없습니다.
              </p>
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
                연체 기준일 (일)
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={dueDaysValue}
                onChange={(event) => setDueDaysValue(event.target.value)}
                style={{
                  width: "100%",
                  padding: "9px 11px",
                  fontSize: "14px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                }}
              />
              <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>
                주문일로부터 이 일수가 지나면 미수금 정산 화면에서 연체로 표시됩니다.
              </p>
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
                허용 결제수단
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {(
                  [
                    { value: "prepaid", label: "직접 정산 (계좌이체 등)" },
                    { value: "on_credit", label: "외상 거래" },
                    ...(pgConfigured ? [{ value: "pg", label: "PG(카드) 결제" } as const] : []),
                  ] as const
                ).map((option) => (
                  <label
                    key={option.value}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "13px",
                      color: "#334155",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={paymentMethodsValue.includes(option.value)}
                      onChange={() => togglePaymentMethod(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              {!pgConfigured && (
                <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>
                  PG(카드) 결제는 이 공급사의 PG 연동(토스페이먼츠)을 먼저 설정해야 이 목록에
                  나타납니다. /dashboard/invites에서 설정할 수 있습니다.
                </p>
              )}
              <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>
                외상은 여신 한도가 0보다 커야 실제로 체크아웃에 노출됩니다.
              </p>
            </div>

            {creditError && (
              <div
                role="alert"
                style={{
                  backgroundColor: "#fee2e2",
                  border: "1px solid #fecaca",
                  color: "#991b1b",
                  fontSize: "12px",
                  padding: "9px 11px",
                  borderRadius: "8px",
                  lineHeight: 1.6,
                }}
              >
                {creditError}
              </div>
            )}

            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setCreditTarget(null)}
                disabled={creditPending}
                style={{ ...chipButtonStyle, padding: "9px 13px" }}
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleSaveCredit}
                disabled={creditPending || readOnly}
                style={{
                  ...chipButtonStyle,
                  backgroundColor: creditPending || readOnly ? "#94a3b8" : "#0f172a",
                  borderColor: creditPending || readOnly ? "#94a3b8" : "#0f172a",
                  color: "#ffffff",
                  padding: "9px 13px",
                  cursor: creditPending || readOnly ? "not-allowed" : "pointer",
                }}
              >
                {creditPending ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
