import { OpenInBrowserView } from "../open-in-browser-view";

export const metadata = {
  title: "출고 스캔 열기 | 도매업체 통합관리시스템",
};

/**
 * 카카오톡 채널 버튼이 가리키는 중간 페이지 (출고용).
 *
 * /go/inbound와 동일한 이유로 존재한다 — 카톡 인앱 브라우저에서는 카메라 접근이
 * 막히는 경우가 많아 바코드 카메라 스캔이 동작하지 않는다.
 *
 * 카카오 채널 관리자센터의 버튼 링크에 이 주소를 넣는다:
 *   https://<도메인>/go/outbound
 */
export default function OutboundEntryPage() {
  return <OpenInBrowserView target="/dashboard/outbound" label="출고" />;
}
