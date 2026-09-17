/**
 * 카카오톡 인앱 브라우저 감지 + 탈출 유틸.
 *
 * 카카오톡 자체 웹뷰는 PDF 인라인 렌더링/파일 다운로드가 모두 막혀 있어(미리보기는
 * 백지, 다운로드는 "페이지가 작동하지 않습니다" 오류), iframe 대신 기본 브라우저로
 * 넘기는 것 말고는 방법이 없다. `kakaotalk://web/openExternal?url=`은 카카오가
 * 공식 지원하는 스킴이다.
 */

const KAKAO_IN_APP_PATTERN = /kakaotalk/i;

export function isKakaoInAppBrowser(userAgent: string): boolean {
  return KAKAO_IN_APP_PATTERN.test(userAgent);
}

export function buildKakaoExternalOpenUrl(absoluteUrl: string): string {
  return `kakaotalk://web/openExternal?url=${encodeURIComponent(absoluteUrl)}`;
}
