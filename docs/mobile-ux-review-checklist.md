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
- ⬜ `/dashboard` (대시보드 홈) — 배너/사이드바만 손봤음, 본문 카드 영역 미검토
- ⬜ `/dashboard/team` (팀원 관리) — 직함 라벨 텍스트만 수정, 전체 모바일 미검토
- ⬜ `/dashboard/invites` (영업·초대장) — 미검토

## 관리자 (/admin/*)

- ⬜ `/admin/categories` — 오늘 부위 관리 기능 추가했으나 모바일 UX 미검토
- ⬜ `/admin/suppliers`
- ⬜ `/admin/admins`

## 바이어 미니샵 (/shop/[shop_token]/*)

- ⬜ `/shop/[shop_token]` (미니샵 홈) — 부위 배지만 추가, 전체 모바일 미검토
- ⬜ `/shop/[shop_token]/cart`
- ⬜ `/shop/[shop_token]/checkout`
- ⬜ `/shop/[shop_token]/orders`

## 인증/온보딩/공개 페이지

- ⬜ `/` (랜딩)
- ⬜ `/login`, `/staff-login`, `/staff-login/pending`
- ⬜ `/onboarding`
- ⬜ `/join-team/[token]`
- ⬜ `/my-shops`
- ⬜ `/terms`, `/privacy` — 공용 푸터만 개선됨, 본문 미검토

## 공용 컴포넌트 (완료)

- ✅ 사이드바(`dashboard-shell.tsx`) — 브랜드 대비, 메뉴 정렬/색상, 하단 여백
- ✅ 푸터(`legal-footer.tsx`) — 아코디언, 가독성
- ✅ 테스트 배너(`staging-banner.tsx`) — 압축, 닫기 버튼

## 보류(별도 결정, 지금 안 함)

- 상품 대표 이미지 업로드 — Storage/DB 컬럼 없음
- 판매 통계 단위(kg/마리) 구분 집계
- 사이드바 아이콘 통일(이모지 → 아이콘 라이브러리)
