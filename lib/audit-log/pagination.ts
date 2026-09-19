/**
 * 한 번에 불러오는 이력 개수 — "더보기"/"다음" 클릭마다 이만큼씩 추가로 가져온다.
 *
 * app/actions/audit-log.ts는 "use server" 파일이라 async 함수만 export할 수 있어서
 * (값 상수를 같이 export하면 Next.js 빌드가 실패한다), 이 상수는 별도 모듈에 둔다.
 */
export const AUDIT_LOG_PAGE_SIZE = 10;
