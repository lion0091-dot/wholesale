/**
 * 개발용 미리보기 패널 — 입고 화면·상품관리 화면이 함께 쓰는 공통 UI.
 *
 * 실제 API·DB를 안 건드리고 화면에만 미리보기 행/상품을 띄우는 버튼 묶음이다.
 * 오픈 전에는 지워야 하는 개발 도구다 — 폐기할 때는 `lib/dev-samples/` 폴더
 * 전체를 지우고, 이 컴포넌트를 쓰는 화면(입고 스캔·상품관리)에서 호출부만
 * 지우면 된다.
 */
"use client";

interface DevSamplePanelProps<K extends string> {
  kinds: Record<K, { label: string }>;
  onAdd: (kind: K) => void;
  onClearAll: () => void;
  hasSamples: boolean;
  description: string;
  /** 버튼 스타일은 화면마다 조금씩 달라 호출부에서 넘긴다(chipButtonStyle 등). */
  buttonStyle: React.CSSProperties;
  containerStyle?: React.CSSProperties;
}

export function DevSamplePanel<K extends string>({
  kinds,
  onAdd,
  onClearAll,
  hasSamples,
  description,
  buttonStyle,
  containerStyle,
}: DevSamplePanelProps<K>) {
  return (
    <div
      style={{
        display: "flex",
        gap: "8px",
        flexWrap: "wrap",
        alignItems: "center",
        padding: "10px 12px",
        backgroundColor: "#fafaf9",
        ...containerStyle,
      }}
    >
      <span style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a" }}>개발용 샘플 보기</span>
      <span style={{ fontSize: "11px", color: "#64748b" }}>{description}</span>
      {(Object.keys(kinds) as K[]).map((kind) => (
        <button key={kind} type="button" onClick={() => onAdd(kind)} style={buttonStyle}>
          {kinds[kind].label}
        </button>
      ))}
      {hasSamples && (
        <button
          type="button"
          onClick={onClearAll}
          style={{ ...buttonStyle, borderColor: "#fca5a5", color: "#b91c1c" }}
        >
          샘플 전체 지우기
        </button>
      )}
    </div>
  );
}
