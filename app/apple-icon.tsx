import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** 아이폰 홈 화면 아이콘 (임시). 모서리는 iOS가 알아서 둥글게 깎는다. */
export default async function AppleIcon() {
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
          fontSize: 100,
          fontWeight: 800,
        }}
      >
        M
      </div>
    ),
    { ...size },
  );
}
