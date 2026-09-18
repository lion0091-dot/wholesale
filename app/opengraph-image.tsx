import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "미트 파트너스";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * 카카오톡/오픈그래프 링크 공유 미리보기 이미지. 정적 파일 없이 요청 시 렌더링한다.
 * 실제 로고가 생기면 이 컴포넌트만 교체하면 된다.
 */
export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0f172a",
          color: "#ffffff",
        }}
      >
        <div style={{ fontSize: 76, fontWeight: 800 }}>미트 파트너스</div>
        <div style={{ fontSize: 28, marginTop: 24, color: "#94a3b8" }}>
          도매업체와 고객(소매)를 위한 1:1 모바일 발주 플랫폼
        </div>
      </div>
    ),
    { ...size }
  );
}
