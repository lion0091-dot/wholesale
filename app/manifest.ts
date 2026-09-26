import type { MetadataRoute } from "next";
import { buildManifest } from "@/lib/pwa/manifest";

/**
 * 기본(공급사 직원) 홈 화면 앱: 시작 화면은 백오피스.
 * 로그인 전이면 미들웨어가 /login으로 보내고, 로그인 후 원래 화면으로 돌아온다.
 * 고객·어드민은 각자 레이아웃이 /pwa/... 앱 설정으로 덮어쓴다.
 */
export default function manifest(): MetadataRoute.Manifest {
  return buildManifest({ id: "/dashboard", start_url: "/dashboard" });
}
