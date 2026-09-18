# 대문 개편 + 고객사 입점 희망 리드 수집

## 배경
기존 대문(`app/page.tsx`)은 개발용 대시보드 바로가기 4개를 그냥 나열한 화면이었다. 실제 서비스 소개 화면으로 바꾸면서, 두 방문자 유형(공급사/고객사)에 맞는 CTA를 분리했다.

## 잠긴 설계 결정
- **"매칭"은 알고리즘이 아니라 관리자 수동 중개**: 고객사가 대문에서 "입점 희망"을 신청하면 `retailer_match_requests` 테이블에 저장될 뿐, 자동으로 공급사와 연결되지 않는다. 관리자(`/admin/retailer-leads`)가 목록을 보고 적합해 보이는 공급사에게 전화 등으로 직접 의뢰하고, 진행 상황(대기/컨택중/매칭완료/종료)을 그 화면에서 수동으로 기록한다. 공급사에게 리드를 노출하는 화면은 만들지 않았다.
- **공급사(도매) 가입 경로는 그대로**: 카카오 3초 로그인(`/login`) 변경 없음.
- **리드 폼은 로그인 불필요**: 아직 시스템 계정이 없는 식당 사장님이 대상이라, `retailer_match_requests` INSERT는 인증 여부와 무관하게(anon 포함) 허용한다. 조회/상태 변경은 super_admin 전용.
- **기존 데모 대시보드 링크는 삭제 안 함**: 상품관리/미니샵체험/발주관리/슈퍼관리자 4개 링크를 대문 하단 "둘러보기" 접이식 섹션으로 옮겼다(기본 접힘). 슈퍼관리자 링크 노출 여부는 여전히 서버(`isSuperAdminSession()`)가 DB 권한으로 판정 — 클라이언트 컴포넌트 전환 과정에서 이 가드를 놓칠 뻔했다가 서버 컴포넌트(`app/page.tsx`)와 클라이언트 하위 컴포넌트(`components/home-explore-links.tsx`)를 분리해 유지했다.

## 아키텍처
- `supabase/migrations/20260930000035_retailer_match_requests.sql` — 리드 테이블 + RLS 3종(누구나 INSERT, super_admin만 SELECT/UPDATE).
- `app/actions/retailer-match-request.ts` — 리드 제출 Server Action(비로그인 허용).
- `app/admin/retailer-leads/` — 관리자 조회 화면(`page.tsx`) + 상태/메모 저장 액션(`actions.ts`) + 목록 컴포넌트(`retailer-lead-list.tsx`). `/admin/suppliers`와 동일한 가드/레이아웃 패턴.
- `app/page.tsx` — 서버 컴포넌트로 유지(슈퍼관리자 권한 판정 때문). 두 하위 클라이언트 컴포넌트를 조합:
  - `components/retailer-lead-section.tsx` — "입점 희망 신청하기" 버튼 ↔ 폼(`retailer-lead-form.tsx`) 토글.
  - `components/home-explore-links.tsx` — 하단 "둘러보기" 접이식 섹션. `showAdminEntry`를 props로만 받고 자체 권한 판단 없음.
- `app/admin/suppliers/page.tsx`에 새 리드 화면으로 가는 링크 한 줄 추가.

## 검증 상태
- `tsc --noEmit`, `next build` 통과.
- 로컬 dev 서버 + agent-browser로 모바일 뷰 스크린샷 확인(사용자 검토 후 배포 승인).
- DB 마이그레이션 라이브 적용 확인(2026-09-18).
- 실제 리드 제출 → 관리자 화면 조회까지의 전체 흐름은 실계정으로 아직 안 해봄.

## 남은 과제
- 리드 폼에 스팸 방지(레이트리밋/캡차 등) 없음 — 공개 폼이라 악용 가능성 있음, 트래픽 생기면 검토.
- 관리자가 "어느 공급사에 의뢰했는지"는 자유 텍스트 메모(`admin_note`)로만 기록 — 공급사 레코드와 정식으로 연결(FK)하는 구조는 아님.
