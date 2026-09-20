"use client";

/** 텍스트 버튼처럼 보이던 ON/OFF 토글을 실제 스위치 형태로 — 터치 시 상태가 직관적으로 보이게 한다. */

interface SizePreset {
  track: string;
  trackHeight: string;
  thumb: string;
  thumbLeftOn: string;
  fontSize: string;
  fontWeight: number;
  offTextColor: string;
}

const SIZE_PRESETS: Record<"sm" | "md", SizePreset> = {
  md: {
    track: "32px",
    trackHeight: "18px",
    thumb: "14px",
    thumbLeftOn: "16px",
    fontSize: "12px",
    fontWeight: 600,
    offTextColor: "#334155",
  },
  sm: {
    track: "30px",
    trackHeight: "17px",
    thumb: "13px",
    thumbLeftOn: "15px",
    fontSize: "11px",
    fontWeight: 700,
    offTextColor: "#94a3b8",
  },
};

interface MiniToggleProps {
  checked: boolean;
  onLabel: string;
  offLabel: string;
  onClick: () => void;
  disabled?: boolean;
  /** 켜졌을 때 트랙 색상 */
  onColor: string;
  /** 켜졌을 때 라벨 색상 — 생략하면 onColor와 동일 */
  onTextColor?: string;
  /** md: 상품 목록, sm: 맞춤단가/핫딜 관리 화면 */
  size?: "sm" | "md";
}

export function MiniToggle({
  checked,
  onLabel,
  offLabel,
  onClick,
  disabled,
  onColor,
  onTextColor,
  size = "md",
}: MiniToggleProps) {
  const preset = SIZE_PRESETS[size];
  const labelColor = onTextColor ?? onColor;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "7px",
        border: "none",
        background: "none",
        padding: "4px 2px",
        cursor: disabled ? "wait" : "pointer",
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: preset.track,
          height: preset.trackHeight,
          borderRadius: "999px",
          backgroundColor: checked ? onColor : "#cbd5e1",
          position: "relative",
          flexShrink: 0,
          transition: "background-color 0.15s ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "2px",
            left: checked ? preset.thumbLeftOn : "2px",
            width: preset.thumb,
            height: preset.thumb,
            borderRadius: "50%",
            backgroundColor: "#ffffff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
            transition: "left 0.15s ease",
          }}
        />
      </span>
      <span
        style={{
          fontSize: preset.fontSize,
          fontWeight: preset.fontWeight,
          color: checked ? labelColor : preset.offTextColor,
        }}
      >
        {checked ? onLabel : offLabel}
      </span>
    </button>
  );
}
