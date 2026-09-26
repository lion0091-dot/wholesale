import { ImageResponse } from "next/og";

export const runtime = "edge";
export const contentType = "image/png";

const SIZES = [192, 512] as const;

export function generateImageMetadata() {
  return SIZES.map((size) => ({
    id: String(size),
    size: { width: size, height: size },
    contentType,
    alt: "미트 파트너스",
  }));
}

/**
 * 홈 화면 앱 아이콘 (임시). 기본 글꼴엔 한글이 없어 영문 "M"으로 그린다.
 * 실제 로고가 생기면 이 파일과 apple-icon.tsx만 교체하면 된다.
 * 글자는 안드로이드 마스크(가장자리 잘림)에 걸리지 않게 중앙 안전 영역에 둔다.
 */
export default async function Icon({ id }: { id: string }) {
  const size = Number(id);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#dc2626",
          color: "#ffffff",
          fontSize: Math.round(size * 0.55),
          fontWeight: 800,
        }}
      >
        M
      </div>
    ),
    { width: size, height: size },
  );
}
