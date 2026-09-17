# 거래명세서(Transaction Statement) 서버사이드 PDF 생성

### 배경
세금계산서(전자세금계산서) 발행은 국세청 ASP 연동·과세유형별 위임 등 별도 스코프가 커서(ROADMAP 후순위) 손대지 않았고, 그 대신 법적 규제가 없는 **거래명세서**(발주 데이터 그대로 정리한 상관례상 참고 문서)만 우선 구현했다. 세금계산서 자동 연동과는 완전히 별개 작업이다.

### 아키텍처
- `lib/orders/statement.ts` — 주문+품목+공급자(도매업자)/공급받는자(바이어) 사업자정보를 조회하는 공용 로더. 공급사용(`loadStatementDataForSupplier`, wholesaler_id만 확인)/바이어용(`loadStatementDataForBuyer`, wholesaler_id+retailer_id 둘 다 확인, 교차 조회 차단)으로 인가 조건만 분리.
- `lib/pdf/transaction-statement.tsx` — `@react-pdf/renderer` 기반 PDF 문서. 하단에 "세금계산서를 대체하지 않는다" 문구 명시.
- `app/dashboard/orders/[id]/statement/route.ts` / `app/shop/[shop_token]/orders/[id]/statement/route.ts` — 각각 공급사 백오피스/바이어 미니샵용 라우트. `export const runtime = "nodejs"` 필수(`@react-pdf/renderer`가 `fs` 등 Node API 의존, Edge 런타임에서 동작 안 함).
- `components/statement-preview-button.tsx` — 새 탭 대신 페이지 안에서 `<iframe>`으로 바로 펼쳐 보는 인앱 미리보기. 열기 전엔 iframe을 렌더링하지 않아(lazy) 불필요한 PDF 생성을 막는다. 발행 불가 경고 HTML도 그대로 iframe 안에 나타나 별도 에러 처리가 필요 없다.

### 잠긴 설계 결정 (재검토 금지)
- **거래명세서 ≠ 세금계산서**: 법정 증빙서류가 아니므로 별도 ASP 연동/사업자 위임 없이 DB의 발주 데이터를 그대로 PDF로 변환. PDF 본문에도 이 취지를 고정 문구로 박아둠(`lib/pdf/transaction-statement.tsx`) — 제거 금지.
- **주소 미등록 시 조용히 `-`로 발행 금지**: `lib/orders/statement.ts`의 `findMissingStatementFields()`가 공급자 주소 누락을 감지하면, 양쪽 라우트 모두 PDF 렌더링 전에 422 + 사람이 읽을 수 있는 경고 HTML(`lib/pdf/statement-warning-page.ts`)을 반환한다. 경고 없이 빈 값으로 발행하는 변경은 하지 말 것.
- **온보딩(가입) 폼에도 주소가 필수** (`20260926000000_supplier_onboarding_business_address.sql`, 결정 뒤집음): 처음엔 `complete_supplier_signup`(SECURITY DEFINER 트랜잭션 함수) 리스크 때문에 `/dashboard/invites` 백필 폼만 추가했으나, 이후 신규 가입 시점부터 필수화하기로 결정 변경. `complete_supplier_signup`에 `p_business_address TEXT`(기본값 없음, 필수) 파라미터를 추가하고 `INVALID_BUSINESS_ADDRESS`(5자 미만 시) 가드를 넣었다. **함수 시그니처가 바뀌어서 `CREATE OR REPLACE`로 대체 불가** — 기존 5-arg 함수를 `DROP FUNCTION`한 뒤 6-arg로 새로 만듦(파라미터 순서: name, representative_name, phone, **business_address**, business_number DEFAULT NULL, marketing_agreed DEFAULT false). `/dashboard/invites` 백필 폼은 이 마이그레이션 이전 가입자를 위해 계속 남겨둔다.
- **`business_address` 컬럼은 SECURITY DEFINER RPC 없이 직접 UPDATE**: `business_number`와 달리 승인 후 잠금·중복검사·`organizations` 동기화가 필요 없어, 기존 RLS 정책("Wholesalers updatable by self or admin", `profile_id = auth.uid()`)만으로 충분하다고 판단(`submitSupplierBusinessAddressAction`, `app/actions/supplier-auth.ts`). 새 RPC를 추가하려 하지 말 것.
- **한글 폰트는 일반 git blob으로 커밋** (2026-09-17, 결정 뒤집음): `assets/fonts/NotoSansKR-{Regular,Bold}.ttf`(정적 인스턴스, 각 ~6MB, Noto Sans KR 가변 폰트를 `fonttools varLib.instancer`로 추출). `@react-pdf/renderer`(fontkit 기반)는 가변 폰트의 굵기 축을 제대로 반영하지 못해 두 정적 인스턴스로 분리했다. 원래는 Git LFS로 추적(`assets/fonts/*.ttf filter=lfs diff=lfs merge=lfs -text`)했으나, Vercel 배포에서 거래명세서/계산서 PDF 라우트가 500을 내는 원인이 됐다 — `git cat-file`로 확인해보니 커밋된 blob이 실제 폰트가 아니라 132바이트짜리 LFS 포인터 텍스트였고, Vercel 빌드가 이걸 스무지하지 않아 fontkit이 그대로 파싱하다 깨진 것. 로컬은 git-lfs가 설치돼 있어 체크아웃 시 smudge되므로 재현이 안 됐다. 폰트 크기가 LFS 없이도 문제없는 수준(6MB대)이라 LFS 추적을 해제하고 실제 바이너리를 git에 직접 커밋하는 쪽으로 되돌렸다. `.gitattributes`는 이제 비어 있다(삭제해도 무방).
- **`Font.register`의 `src`는 파일 경로 문자열**: Buffer가 아니라 `path.join(process.cwd(), "assets/fonts", ...)` 문자열을 그대로 넘긴다 — `@react-pdf/font`가 URL이 아니면 내부적으로 `fontkit.open()`(파일 경로)로 처리하기 때문. Buffer를 넘기면 타입 에러남.

### 검증 상태
- `tsc --noEmit` 통과.
- 로컬 `next dev` 서버로 실제 route handler를 직접 호출해 한글(Regular/Bold) 렌더링 확인, 인앱 미리보기(`StatementPreviewButton`)의 정상/발행불가 두 케이스 모두 모의 데이터로 확인. 테스트용 임시 라우트는 매번 정리함(커밋 안 됨).
- **실제 Supabase 인증 세션(공급사/바이어 실계정)으로는 아직 검증 안 함** — 로컬 dev + 데모/모의 데이터로만 확인.
- `wholesalers.business_address` 마이그레이션(`20260925000000_wholesaler_business_address.sql`)은 사용자가 Supabase SQL Editor에 직접 적용함 — Claude 세션에서 DB에 직접 쓴 적 없음.
- `20260926000000_supplier_onboarding_business_address.sql`(`complete_supplier_signup` 6-arg 전환)은 라이브 DB에 적용하기 전, `pg` 드라이버(`npm install --no-save pg`, `scripts/db-connect.mjs` 재사용)로 실제 스키마에 `BEGIN...ROLLBACK` 트랜잭션을 걸고 그 안에서 (1) 마이그레이션 SQL 자체가 적용되는지, (2) 새 시그니처가 맞는지, (3) 빈 주소가 `INVALID_BUSINESS_ADDRESS`로 거절되는지, (4) 정상 케이스에서 `wholesalers.business_address`까지 실제로 저장되는지 확인함 — 전부 통과, 라이브 데이터는 변경 없음(스크립트는 커밋 안 됨). **실제 적용은 사용자가 직접 SQL Editor에서 수행 예정.**

### 남은 과제
- `20260926000000_supplier_onboarding_business_address.sql` 라이브 적용(사용자가 SQL Editor에서 수행).
- 실계정 라이브 검증(공급사 로그인 → 주소 등록 → PDF 발행, 바이어 로그인 → 발행 확인).
- 국세청 전자세금계산서 ASP 자동 연동(별도 스코프, ROADMAP 후순위, 미착수).
- **Git LFS → 일반 blob 전환이 실제로 Vercel 500을 고치는지 배포 후 재확인 필요** (2026-09-17 수정, 아직 배포 확인 전).
