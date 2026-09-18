## Platform Admin Allowlist (feat/platform-admin-allowlist)

- [docs/platform-admin-allowlist.md](docs/platform-admin-allowlist.md) — 아키텍처, 잠긴 설계 결정, 핵심 DB 함수 레퍼런스, 관련 애플리케이션 파일, 5단계 롤아웃 상태(현재 Step 4 진행 중), 검증 관련.
- [docs/staff-login-separation.md](docs/staff-login-separation.md) — 내부 스태프 로그인(`/staff-login`) vs 공급사 로그인(`/login`) 분리, `signup_channel` 가드. 같은 브랜치의 별도 기능.

## 가입 시 개인정보 동의 시점 정렬 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/supplier-signup-pii-consent.md](docs/supplier-signup-pii-consent.md) — 카카오 가입 직후 동의 전에 개인정보가 저장되던 문제와 수정 내역. 바이어 쪽 동의 화면 부재는 후속 과제로 남음.

## wholesaler_retailers RLS 정책 누락 (심각 버그, 별도 발견)

- [docs/wholesaler-retailers-rls-fix.md](docs/wholesaler-retailers-rls-fix.md) — RLS 정책이 0개라 카탈로그/발주/고객관리가 전부 막혀있던 문제와 수정. 실계정 라이브 재검증 아직 안 함.

## 거래명세서 PDF 생성 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/transaction-statement-pdf.md](docs/transaction-statement-pdf.md) — 세금계산서와는 별개인 거래명세서(법정 증빙서류 아님) 서버사이드 PDF 생성. 아키텍처, 잠긴 설계 결정(주소 미등록 시 발행 차단, 한글 폰트는 Git LFS가 아닌 일반 git blob으로 커밋 — Vercel 500 버그로 뒤집음), 검증 상태(실계정 라이브 미검증), 남은 과제.

## 국세청 사업자등록정보 진위확인 API 연동 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- data.go.kr 국세청_사업자등록정보 진위확인 API로 입점 승인 심사를 실제 국세청 데이터와 대조하도록 변경. 체크섬(형식) 검증만으로는 실존하지 않는 가짜 번호도 승인 버튼이 활성화되던 문제를 해결. 개업일자(`business_start_date`) 컬럼 신규 추가, 기존 승인대기 공급사는 재제출 필요.

## 계산서(면세) 작성 도우미 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/tax-invoice-draft.md](docs/tax-invoice-draft.md) — 세금계산서 자동발행(Post-MVP, 미착수)과는 별개로, 홈택스 수동 입력을 돕는 계산서(면세) 작성 초안 PDF 도우미. 과세/면세 판단 근거(잠긴 결정), 아키텍처, 남은 과제.

## 배송 조회 스위트트래커 연동 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/delivery-tracking.md](docs/delivery-tracking.md) — 운송장 발급/배송비 정산은 대행하지 않고 스위트트래커 API로 조회만 대행. 잠긴 설계 결정(정산 비관여, 상태 캐싱 안 함, Server Action 패턴), 아키텍처. API 키 미발급(2026-09-17 기준)이라 실조회 미검증 — 문서·코드 준비만 완료.

## 축산물 경락가격 위젯 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/market-price-widget.md](docs/market-price-widget.md) — ROADMAP §1 공공 시세 API 연동. 원매가 참고란 옆에 오늘 전국 평균 경락가(소/돼지)를 보여주는 참고용 위젯. DB 테이블·API 클라이언트·크론·조회 액션·UI 위젯까지 코드 전부 완료(커밋 전). KAPE API 키만 미발급 — 발급 전엔 위젯이 "시세 데이터 없음" 안내로 안전하게 폴백.

## 카카오 알림톡 실제 발송 연동 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/alimtalk-integration.md](docs/alimtalk-integration.md) — 기존 스텁(플랫폼 공용 키 가정)을 공급사별 자격정보(비즈뿌리오 1:1 계약) 구조로 전면 재설계. 잠긴 설계 결정(비밀번호 AES 암호화 저장, 플랫폼이 대행사 계정 관리 안 함, 설정 화면 owner/manager 전용), 비즈뿌리오 API 스펙, 코드 전부 완료. 실계정 미검증.

## Downloads 폴더 패치 3개 보류 (2026-09-16, Vercel 배포 우선 진행 중)

- [docs/deferred-drive-patches.md](docs/deferred-drive-patches.md) — 이전 세션 산출물 패치 3개(PRD/ROADMAP 8번 섹션 추가, wholesaler 구버전 화면 삭제, KNOWN_GAPS.md 신규 생성) 검토 결과 전부 stale로 판정, 적용 보류. Vercel 배포 완료 후 재검토 예정.
