import type { MetadataRoute } from "next";

export type ManifestOverrides = Pick<MetadataRoute.Manifest, "id" | "start_url">;

/**
 * 홈 화면 앱 설정의 공통 부분. 역할(공급사 직원·고객·어드민)마다 시작 화면과 id만 다르다.
 * id를 따로 줘야 같은 사이트에서 역할별로 홈 화면에 각각 추가해도 서로 덮어쓰지 않는다.
 * 서비스워커(오프라인·푸시)는 의도적으로 넣지 않았다.
 */
export function buildManifest({ id, start_url }: ManifestOverrides): MetadataRoute.Manifest {
  return {
    id,
    name: "미트 파트너스",
    short_name: "미트파트너스",
    description: "도매업체와 고객(소매)를 위한 1:1 모바일 발주 플랫폼",
    start_url,
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#dc2626",
    lang: "ko",
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

export function manifestResponse(manifest: MetadataRoute.Manifest): Response {
  return new Response(JSON.stringify(manifest), {
    headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=0, must-revalidate" },
  });
}
