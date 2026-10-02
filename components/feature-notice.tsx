/**
 * 켜지지 않았거나 허용되지 않은 기능 화면을 열었을 때 보여주는 안내(마이그레이션 210).
 * 데이터는 DB가 이미 막고 있고, 여기는 빈 화면 대신 이유를 알려주는 역할이다.
 */
export function FeatureNotice({ screenName, children }: { screenName: string; children?: React.ReactNode }) {
  return (
    <section
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        padding: "20px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      }}
    >
      <h1 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: 0 }}>{screenName}</h1>
      <p style={{ fontSize: "13px", color: "#475569", lineHeight: 1.7, margin: 0 }}>
        {children ??
          "이 기능은 이용 중인 업체에서, 대표님이 허용한 사람만 볼 수 있어요. 아직 안 보이면 대표님께 허용을 요청해 주세요. 이용 신청은 운영팀에 문의해 주세요."}
      </p>
    </section>
  );
}
