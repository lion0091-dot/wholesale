/**
 * 데모(샘플) 데이터 행/카드에 붙이는 작은 배지.
 * 화면 상단 데모 안내 배너와 같은 색상(#fef3c7 / #92400e)을 써서
 * "이게 데모 상태다"라는 시각 언어를 항목 단위로도 일관되게 전달한다.
 */
export function SampleBadge() {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "11px",
        fontWeight: 700,
        color: "#92400e",
        backgroundColor: "#fef3c7",
        border: "1px solid #fde68a",
        borderRadius: "4px",
        padding: "2px 7px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      샘플
    </span>
  );
}
