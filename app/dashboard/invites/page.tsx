import Link from "next/link";
import { CopyInviteButton } from "@/components/copy-invite-button";
import { PendingApprovalBanner } from "@/components/pending-approval-banner";
import { formatBusinessNumber } from "@/lib/validation/business-number";
import {
  BUSINESS_NUMBER_REQUIRED_NOTICE,
  describeInviteRestriction,
  getSupplierAccount,
} from "@/lib/supplier/verification";
import { BusinessAddressForm } from "./business-address-form";
import { BusinessNumberForm } from "./business-number-form";
import { BusinessLicenseForm } from "./business-license-form";
import { ShopThumbnailForm } from "./shop-thumbnail-form";
import { WithdrawWholesalerButton } from "./withdraw-wholesaler-button";
import { AlimtalkSettingsForm } from "./alimtalk-settings-form";
import { getAlimtalkSettingsAction } from "@/app/actions/alimtalk-settings";
import { PgSettingsForm } from "./pg-settings-form";
import { getPgSettingsAction } from "@/app/actions/pg-settings";

export const metadata = {
  title: "영업 · 초대장 | 도매업체 통합관리시스템",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "18px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

const STATUS_LABELS: Record<string, { label: string; bg: string; color: string }> = {
  pending: { label: "승인 심사 대기", bg: "#fef3c7", color: "#92400e" },
  active: { label: "승인 완료", bg: "#dcfce7", color: "#166534" },
  suspended: { label: "이용 일시정지", bg: "#fee2e2", color: "#991b1b" },
  rejected: { label: "심사 거절", bg: "#fee2e2", color: "#991b1b" },
};

function StateRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "12px",
        padding: "9px 0",
        borderBottom: "1px solid #f1f5f9",
        fontSize: "13px",
      }}
    >
      <span style={{ color: "#64748b", fontWeight: 600 }}>{label}</span>
      <span style={{ color: "#0f172a", textAlign: "right", wordBreak: "keep-all" }}>{value}</span>
    </div>
  );
}

/**
 * 영업 · 초대장 발부 화면.
 *
 * 미승인(Pending Supplier) 공급사도 이 화면에 들어올 수 있다. 다만 초대장 발부
 * 버튼만 잠기고, 무엇이 남았는지(사업자등록번호 제출 / 심사 대기)를 함께 보여준다.
 */
export default async function DashboardInvitesPage() {
  const account = await getSupplierAccount();

  // 데모 모드(미인증) — 실제 토큰이 없으므로 발부 UI를 잠근 상태로 보여준다.
  if (!account) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <header>
          <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>영업 · 초대장</h1>
          <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
            고객(소매)에게 보낼 미니샵 전용 초대장을 발부합니다.
          </p>
        </header>

        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
            lineHeight: 1.6,
          }}
        >
          ℹ️ 로그인되지 않은 데모 모드입니다.{" "}
          <Link href="/login" style={{ fontWeight: 700, color: "#b45309" }}>
            카카오로 로그인
          </Link>
          하면 내 미니샵 초대장을 발부할 수 있습니다.
        </div>

        <section style={cardStyle}>
          <CopyInviteButton
            canIssue={false}
            restrictionMessage="로그인 후 승인된 공급사 계정에서만 초대장을 발부할 수 있습니다."
          />
        </section>
      </div>
    );
  }

  const restriction = describeInviteRestriction(account);
  const canIssue = account.canIssueInvite;
  const statusBadge = STATUS_LABELS[account.supplierStatus ?? "pending"] ?? STATUS_LABELS.pending;

  const alimtalkSettingsResult = account.wholesalerId ? await getAlimtalkSettingsAction() : null;
  const alimtalkSettings =
    alimtalkSettingsResult?.success && alimtalkSettingsResult.data
      ? alimtalkSettingsResult.data
      : null;

  const pgSettingsResult = account.wholesalerId ? await getPgSettingsAction() : null;
  const pgSettings =
    pgSettingsResult?.success && pgSettingsResult.data ? pgSettingsResult.data : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>영업 · 초대장</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px", lineHeight: 1.7 }}>
          고객(소매)에게 보낼 미니샵 전용 초대장(카카오톡 문구 + 발주 링크)을 발부합니다. 링크를 받은
          고객(소매)만 내 상품과 단가를 볼 수 있습니다.
        </p>
      </header>

      {!canIssue && restriction && (
        <PendingApprovalBanner
          message={restriction}
          detail={account.businessNumber ? null : BUSINESS_NUMBER_REQUIRED_NOTICE}
        />
      )}

      <section style={cardStyle}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
          초대장 발부
        </div>
        <CopyInviteButton
          canIssue={canIssue}
          restrictionMessage={restriction}
          shopToken={canIssue ? account.shopToken : null}
        />
        {canIssue && (
          <p style={{ fontSize: "12px", color: "#94a3b8", marginTop: "10px", lineHeight: 1.7 }}>
            복사한 문구를 카카오톡으로 그대로 전달하세요. 고객(소매)이 링크를 열고 카카오 로그인 한
            번을 마치면 단골 거래처로 자동 등록됩니다.
          </p>
        )}
      </section>

      <section style={cardStyle}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>
          승인 상태
        </div>

        <StateRow label="상호(업체명)" value={account.businessName ?? "미등록"} />
        <StateRow
          label="계정 유형"
          value={
            account.isSuperAdmin
              ? "플랫폼 슈퍼관리자"
              : account.isSupplier
                ? "공급사(도매)"
                : "일반 계정"
          }
        />
        <StateRow
          label="행정 승인"
          value={
            <span
              style={{
                fontSize: "12px",
                fontWeight: 700,
                backgroundColor: account.isVerified ? "#dcfce7" : statusBadge.bg,
                color: account.isVerified ? "#166534" : statusBadge.color,
                borderRadius: "999px",
                padding: "3px 10px",
              }}
            >
              {account.isVerified ? "승인 완료" : statusBadge.label}
            </span>
          }
        />
        <StateRow
          label="사업자등록번호"
          value={
            account.businessNumber ? formatBusinessNumber(account.businessNumber) : "미제출"
          }
        />
        <StateRow
          label="사업장 주소"
          value={
            account.businessAddress ? (
              account.businessAddress
            ) : (
              <span style={{ color: "#b91c1c", fontWeight: 700 }}>미등록 (거래명세서 발행 불가)</span>
            )
          }
        />
        <StateRow
          label="초대장 발부 권한"
          value={canIssue ? "사용 가능" : "승인 후 활성화"}
        />
      </section>

      {!account.isVerified && account.wholesalerId && (
        <section style={cardStyle}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "4px" }}>
            사업자 정보 제출
          </div>
          <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.7, marginBottom: "12px" }}>
            사업자등록번호를 제출하면 플랫폼 운영팀이 등록증을 대조해 승인 여부를 확정합니다.
            승인 전에도 상품 등록·단가·발주 관리는 제한 없이 사용할 수 있습니다.
          </p>
          <BusinessNumberForm
            currentBusinessNumber={account.businessNumber}
            currentBusinessStartDate={account.businessStartDate}
          />
          <BusinessLicenseForm currentUploadedAt={account.businessLicenseUploadedAt} />
        </section>
      )}

      {account.wholesalerId && (
        <section style={cardStyle}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "4px" }}>
            사업장 주소 {account.businessAddress ? "" : "— 아직 등록되지 않았습니다"}
          </div>
          <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.7, marginBottom: "12px" }}>
            거래명세서 PDF의 공급자란에 표시되는 주소입니다. 승인 여부와 무관하게 언제든 등록·수정할
            수 있습니다.
          </p>
          <BusinessAddressForm currentBusinessAddress={account.businessAddress} />
        </section>
      )}

      {account.wholesalerId && (
        <section style={cardStyle}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "4px" }}>
            미니샵 썸네일
          </div>
          <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.7, marginBottom: "12px" }}>
            고객(소매)의 &quot;내 거래처&quot; 목록에서 상호명 옆에 표시되는 업체 대표 사진/로고입니다.
          </p>
          <ShopThumbnailForm currentThumbnailUrl={account.shopThumbnailUrl} />
        </section>
      )}

      {account.wholesalerId && alimtalkSettings && (
        <section style={cardStyle}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "4px" }}>
            알림톡 연동 설정
          </div>
          <AlimtalkSettingsForm initial={alimtalkSettings} />
        </section>
      )}

      {account.wholesalerId && pgSettings && (
        <section style={cardStyle}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", marginBottom: "4px" }}>
            PG(카드) 결제 연동 설정
          </div>
          <PgSettingsForm initial={pgSettings} />
        </section>
      )}

      {account.wholesalerId && account.isWholesalerOwner && account.supplierStatus !== "closed" && (
        <WithdrawWholesalerButton />
      )}
    </div>
  );
}
