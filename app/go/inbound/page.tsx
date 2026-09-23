import { OpenInBrowserView } from "../open-in-browser-view";

export const metadata = {
  title: "입고 스캔 열기 | 도매업체 통합관리시스템",
};

/**
 * 카카오톡 채널 버튼이 가리키는 중간 페이지.
 *
 * 채널 버튼을 누르면 카톡 인앱 브라우저가 열리는데, 거기서는 카메라 접근이
 * 막히는 경우가 많아 바코드 카메라 스캔이 동작하지 않는다. 그래서 이 페이지가
 * 인앱 브라우저를 감지해 기본 브라우저로 넘겨준다.
 *
 * 이 경로는 /dashboard가 아니라 로그인 가드 밖이다(middleware의 SUPPLIER_PREFIXES).
 * 로그인 전에도 열려야 브라우저를 먼저 바꾸고 거기서 로그인할 수 있기 때문이다.
 *
 * 카카오 채널 관리자센터의 버튼 링크에 이 주소를 넣는다:
 *   https://<도메인>/go/inbound
 */
export default function InboundEntryPage() {
  return <OpenInBrowserView target="/dashboard/inbound" label="입고" />;
}
