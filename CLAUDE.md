## Platform Admin Allowlist (feat/platform-admin-allowlist)

- [docs/platform-admin-allowlist.md](docs/platform-admin-allowlist.md) — 아키텍처, 잠긴 설계 결정, 핵심 DB 함수 레퍼런스, 관련 애플리케이션 파일, 5단계 롤아웃 상태(현재 Step 4 진행 중), 검증 관련.
- [docs/staff-login-separation.md](docs/staff-login-separation.md) — 내부 스태프 로그인(`/staff-login`) vs 공급사 로그인(`/login`) 분리, `signup_channel` 가드. 같은 브랜치의 별도 기능.

## 가입 시 개인정보 동의 시점 정렬 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/supplier-signup-pii-consent.md](docs/supplier-signup-pii-consent.md) — 카카오 가입 직후 동의 전에 개인정보가 저장되던 문제와 수정 내역. 바이어 쪽 동의 화면 부재는 후속 과제로 남음.

## wholesaler_retailers RLS 정책 누락 (심각 버그, 별도 발견)

- [docs/wholesaler-retailers-rls-fix.md](docs/wholesaler-retailers-rls-fix.md) — RLS 정책이 0개라 카탈로그/발주/고객관리가 전부 막혀있던 문제와 수정. 실계정 라이브 재검증 아직 안 함.

## 거래명세서 PDF 생성 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/transaction-statement-pdf.md](docs/transaction-statement-pdf.md) — 세금계산서와는 별개인 거래명세서(법정 증빙서류 아님) 서버사이드 PDF 생성. 아키텍처, 잠긴 설계 결정(주소 미등록 시 발행 차단, 한글 폰트 Git LFS 추적 등), 검증 상태(실계정 라이브 미검증), 남은 과제.

## 국세청 사업자등록정보 진위확인 API 연동 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- data.go.kr 국세청_사업자등록정보 진위확인 API로 입점 승인 심사를 실제 국세청 데이터와 대조하도록 변경. 체크섬(형식) 검증만으로는 실존하지 않는 가짜 번호도 승인 버튼이 활성화되던 문제를 해결. 개업일자(`business_start_date`) 컬럼 신규 추가, 기존 승인대기 공급사는 재제출 필요.

## 계산서(면세) 작성 도우미 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/tax-invoice-draft.md](docs/tax-invoice-draft.md) — 세금계산서 자동발행(Post-MVP, 미착수)과는 별개로, 홈택스 수동 입력을 돕는 계산서(면세) 작성 초안 PDF 도우미. 과세/면세 판단 근거(잠긴 결정), 아키텍처, 남은 과제.

## Downloads 폴더 패치 3개 보류 (2026-09-16, Vercel 배포 우선 진행 중)

- [docs/deferred-drive-patches.md](docs/deferred-drive-patches.md) — 이전 세션 산출물 패치 3개(PRD/ROADMAP 8번 섹션 추가, wholesaler 구버전 화면 삭제, KNOWN_GAPS.md 신규 생성) 검토 결과 전부 stale로 판정, 적용 보류. Vercel 배포 완료 후 재검토 예정.
