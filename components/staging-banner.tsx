/**
 * 테스트/스테이징 환경 안내 배너.
 * NEXT_PUBLIC_IS_LIVE=true 를 명시적으로 설정한 배포(실제 오픈 시점)에서만 숨겨진다.
 * 안전한 기본값: 값이 없으면(로컬/스테이징) 항상 노출.
 */
const isLive = process.env.NEXT_PUBLIC_IS_LIVE === "true";

export function StagingBanner() {
  if (isLive) {
    return null;
  }

  return (
    <div
      style={{
        backgroundColor: "#fde047",
        color: "#713f12",
        textAlign: "center",
        padding: "6px 12px",
        fontSize: "12px",
        fontWeight: 700,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      ⚠️ 테스트 환경 — 데이터가 예고 없이 초기화될 수 있습니다.
    </div>
  );
}
