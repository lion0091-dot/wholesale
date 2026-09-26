import { buildManifest, manifestResponse } from "@/lib/pwa/manifest";

/**
 * 어드민 홈 화면 앱 설정. /admin 안에 두면 미들웨어 로그인 가드가 앱 설정 요청
 * (브라우저는 쿠키를 안 보낸다)을 로그인 화면으로 돌려보내므로 가드 밖(/pwa)에 둔다.
 */
export function GET() {
  return manifestResponse(buildManifest({ id: "/admin", start_url: "/admin" }));
}
