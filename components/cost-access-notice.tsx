/**
 * 원가가 담긴 화면(전표관리·매입 정산 등)을 대표·전표 담당 직원이 아닌 사람이 열었을 때 보여주는 안내.
 * 데이터는 DB가 이미 막고 있고(마이그레이션 209), 여기는 빈 화면 대신 이유를 알려주는 역할이다.
 */
export function CostAccessNotice({ screenName }: { screenName: string }) {
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
        이 화면에는 매입 단가 같은 원가 정보가 있어서 대표님과 전표 담당 직원만 볼 수 있어요.
        전표 담당 직원은 대표님이 설정의 팀원 관리에서 지정합니다.
      </p>
    </section>
  );
}
