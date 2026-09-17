# 모바일 UX 점검 체크리스트 (2026-09-17 시작)

전 화면을 대상으로 모바일(좁은 화면) 가독성/터치 UX를 하나씩 점검. 완료(✅) / 미착수(⬜)로 표시하고 순서대로 처나간다.

## 공급사 백오피스 (/dashboard/*)

- ✅ `/dashboard/products` — 목록 카드형, 안내 아코디언, 토글, 검색줄, 아이콘
- ✅ `/dashboard/products/new`, `/dashboard/products/[id]/edit` — 하단 고정 버튼바, 단가 콤마+칩, 토글, 바텀시트 피커, 줄바꿈
- ✅ `/dashboard/custom-prices` — placeholder 콤마, 경고 강조, 목록 카드형
- ✅ `/dashboard/orders` — 목록 카드형, 필터탭 스크롤 그라데이션
- ✅ `/dashboard/orders/[id]` — 품목 테이블 카드형
- ✅ `/dashboard/receivables` — 목록 카드형(체크박스 포함)
- ✅ `/dashboard/stats` — 부위별 테이블 카드형
- ✅ `/dashboard/customers` — 이전 세션에서 이미 카드/테이블 토글 구현됨(확인만, 재작업 불필요)
- ✅ `/dashboard` (대시보드 홈) — 이미 카드/flex-wrap 구조라 테이블 잘림 문제 없음, 추가 수정 불필요
- ✅ `/dashboard/team` (팀원 관리) — 이미 카드형 div+flexWrap 구조, 잘림 문제 없음
- ✅ `/dashboard/invites` (영업·초대장) — 테이블 없음, 이미 카드형(StateRow flex), 수정 불필요

## 관리자 (/admin/*)

- ✅ `/admin/categories` — 카테고리/부위 매니저 이미 카드+flexWrap, 인풋 flex:1이라 좁은 화면 대응됨, 수정 불필요
- ✅ `/admin/suppliers` — 이미 카드형(공급사별 카드, 필터탭 스크롤, 배지 flexWrap), 수정 불필요
- ✅ `/admin/admins` — 관리자 목록/승격 검색 모두 카드+flexWrap, 수정 불필요

## 바이어 미니샵 (/shop/[shop_token]/*)

- ✅ `/shop/[shop_token]` (미니샵 홈) — 이미 모바일 우선 설계(그리드 카드, 카테고리 칩 스크롤, 하단 고정 장바구니 바), 수정 불필요
- ✅ `/shop/[shop_token]/cart` — 카드형 라인아이템 + 하단 고정 CTA, 수정 불필요
- ✅ `/shop/[shop_token]/checkout` — 폼 입력 모두 카드+label 구조, 결제방식 라디오 grid, 수정 불필요
- ✅ `/shop/[shop_token]/orders` — article 카드형, 취소요청 폼 인라인 확장, 수정 불필요

## 인증/온보딩/공개 페이지

- ✅ `/` (랜딩) — maxWidth 600px 단일 컬럼, 전체너비 버튼, 수정 불필요
- ✅ `/login`, `/staff-login`, `/staff-login/pending` — maxWidth 420px 카드, 전체너비 카카오 버튼, 수정 불필요
- ✅ `/onboarding` — 폼 인풋 전체 width:100%, 체크박스 행 flex, 수정 불필요
- ✅ `/join-team/[token]` — login과 동일 패턴(maxWidth 420px), 수정 불필요
- ✅ `/my-shops` — 카드형 거래처 리스트, 아이콘/텍스트 flex, 수정 불필요
- ✅ `/terms`, `/privacy` — 본문 확인 완료. 단일 컬럼 텍스트 흐름(maxWidth 768px), 표/고정폭 요소 없어 좁은 화면에서도 자연스럽게 줄바꿈됨. 수정 불필요

## 점검 완료 (2026-09-17)

전 화면 점검 끝. 실계정으로 실제 좁은 화면(360px 안팎) 클릭 테스트는 아직 안 함 — 코드 레벨 구조 검토만 완료.

## 공용 컴포넌트 (완료)

- ✅ 사이드바(`dashboard-shell.tsx`) — 브랜드 대비, 메뉴 정렬/색상, 하단 여백
- ✅ 푸터(`legal-footer.tsx`) — 아코디언, 가독성
- ✅ 테스트 배너(`staging-banner.tsx`) — 압축, 닫기 버튼

## 보류(별도 결정, 지금 안 함)

- 상품 대표 이미지 업로드 — Storage/DB 컬럼 없음
- 판매 통계 단위(kg/마리) 구분 집계
- 사이드바 아이콘 통일(이모지 → 아이콘 라이브러리)
