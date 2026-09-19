/**
 * 상호명/배송지가 아직 카카오 로그인 직후 자리표시자 그대로인 거래처에 붙이는 배지.
 * 담당자도 상호와 같은 카카오 계정에서 나오므로 이 배지가 뜨면 담당자 정보도
 * 같이 비어있다고 보면 된다 — app/dashboard/customers/page.tsx의 hasIncompleteProfile 참고.
 */
export function IncompleteProfileBadge() {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "11px",
        fontWeight: 700,
        color: "#c2410c",
        backgroundColor: "#ffedd5",
        border: "1px solid #fed7aa",
        borderRadius: "4px",
        padding: "2px 7px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      ⚠️ 정보 미흡
    </span>
  );
}
