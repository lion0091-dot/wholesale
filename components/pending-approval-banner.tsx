import Link from "next/link";

interface PendingApprovalBannerProps {
  /** 안내 문구 (lib/supplier/verification.ts 의 사유 문구를 그대로 전달한다) */
  message: string;
  /** 사업자등록번호 미제출 등 추가 조치가 필요할 때 덧붙이는 문구 */
  detail?: string | null;
  /** 초대장 메뉴로 유도할지 여부 (초대장 화면 자체에서는 끈다) */
  showInviteLink?: boolean;
}

/**
 * 미승인(Pending Supplier) 공급사 안내 배너.
 *
 * 승인 심사는 비동기로 진행되고 그 사이에도 기본 기능은 전부 열려 있다.
 * 따라서 "차단"이 아니라 "초대장 발부만 대기 중"임을 분명히 알린다.
 */
export function PendingApprovalBanner({
  message,
  detail,
  showInviteLink = false,
}: PendingApprovalBannerProps) {
  return (
    <div
      role="status"
      style={{
        backgroundColor: "#fffbeb",
        border: "1px solid #fde68a",
        borderRadius: "10px",
        padding: "14px 16px",
        display: "flex",
        gap: "10px",
        alignItems: "flex-start",
      }}
    >
      <span aria-hidden style={{ fontSize: "16px", lineHeight: 1.4 }}>
        ⏳
      </span>
      <div style={{ fontSize: "13px", color: "#92400e", lineHeight: 1.7 }}>
        <div style={{ fontWeight: 800, marginBottom: "2px" }}>승인 심사 진행 중</div>
        {message}
        {detail && (
          <>
            <br />
            <span style={{ color: "#b45309" }}>{detail}</span>
          </>
        )}
        {showInviteLink && (
          <>
            <br />
            <Link
              href="/dashboard/invites"
              style={{ fontWeight: 700, color: "#b45309", textDecoration: "underline" }}
            >
              승인 상태 및 사업자 정보 확인 →
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
