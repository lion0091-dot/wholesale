# 축산물 경락가격 위젯 (공공 시세 참고)

### 배경
ROADMAP §1 "축산물품질평가원 공공 시세 API 연동". 공급사가 상품 등록 화면의 "원매가(매입 원가) 참고란"(현재 DB 미저장, 화면 계산용) 옆에서 오늘 전국 평균 경락가를 같이 보고 자기 매입가와 눈으로 비교할 수 있게 하는 게 목적. 상품 SKU(예: "한우 1++ 등심 300g")와 API의 등급 단위가 정확히 안 맞아서 DB에 상품별로 강제 매핑하지 않고 참고용 위젯으로만 노출한다.

### API 조사 결과 (2026-09-18, data.go.kr + 브라우저로 직접 확인)
제공기관: 축산물품질평가원(KAPE). 신청은 data.go.kr에서 "활용신청" — **개발/운영 단계 모두 자동승인**(무료, 심사 대기 없음). 개발계정 트래픽 한도 일 1,000회. REST, XML 응답.

**소(한우/육우) 전국 평균 경락가** — data.go.kr 데이터셋 `축산물품질평가원_축산물등급판정정보`(15058822)의 "축산물 도매시장 소도체 등급별 경락가격정보" 오퍼레이션.
- 서비스 URL: `http://data.ekape.or.kr/openapi-data/service/user/grade/auct/cattle`
- 요청 파라미터(전부 옵션, serviceKey만 필수):
  - `startYmd`/`endYmd` (8자, YYYYMMDD) — 경매 시작/종료일. 생략 시 동작은 미확인(실제 호출로 검증 필요).
  - `breedCd` (품종), `sexCd` (성별)
  - `qgradeYn` (N=등급별조회, Y=육질등급별조회)
  - `defectIncludeYn` (Y=결함포함가격, N=결함제외가격)
  - `serviceKey` (100자, 필수, URL-encode)
- 응답: 행마다 `gradeCd`/`gradeNm`(등급코드/명), `judgeBreedCd`(품종코드), `judgeSexNm`(성별), 시장별 `c_XXXX Amt`/`c_XXXX Cnt`(개별 공판장 가격/두수, 매우 많음) + **`CTotAmt`(전국 평균가), 두수 전체 필드**(정확한 영문명은 `CTotAmt` 바로 다음 열 — 실제 XML 응답으로 재확인 필요), `resultCode`/`resultMsg`.

**돼지 전국 평균 경락가** — 같은 데이터셋(15058822)의 "돼지도체 등급별 경락가격정보" 오퍼레이션.
- 서비스 URL: `http://data.ekape.or.kr/openapi-data/service/user/grade/auct/pigGrade`
- 요청 파라미터(전부 옵션, serviceKey만 필수): `startYmd`/`endYmd`, `skinYn`(Y=탕박/N=박피), `sexCd`, `egradeExceptYn`(등외등급 포함/제외)
- 응답: 행마다 `gradeCd`/`gradeNm`, 시장별 가격/두수 필드들 + `CTotAmt`(전국 평균가), `resultCode`/`resultMsg`.

**주의(다른 후보 API, 채택 안 함)**:
- `data.go.kr/data/15057912`(축산물경락가격정보)의 "제주 돼지도체 등급별 경락가격 정보 조회"(`pigJejuGrade`)는 **제주 지역 한정**이라 전국 위젯 용도로는 부적합.
- 같은 15057912의 "쇠고기 부분육 경락가격 조회"(`beefGrade`, 엔드포인트 `.../auct/beefGrade`)는 부위(안심 등)별 한우/육우 등급별 경락가(`hanAvg_0~5`, `yukAvg_0~5` 등)를 제공 — 등급별 소계 가격이라 위 `cattle` 오퍼레이션과 겹치는 정보. 나중에 "부위별" 세분화가 필요해지면 이쪽으로 확장 고려.
- `data.go.kr/data/15000577`(축산물유통정보)의 `LPStock` 오퍼레이션은 재고동향이라 가격 정보 없음 — 채택 안 함.
- 15058822 데이터셋엔 이 외에도 "소 권역별 경락가격현황", "돼지 권역별 경락가격 현황", "실시간 경매현황" 등 20여 개 오퍼레이션이 더 있음 — 지역별/실시간 세분화가 필요해지면 참고.

### 클라이언트 구현 메모 (`lib/market-price/kape-client.ts`)
- 실제 XML 응답 구조(response/header/body/items/item 등 정확한 중첩)를 아직 확인 못 해서, 파싱된 트리를 재귀 탐색해 `resultCode`와 `gradeNm`이 있는 노드를 찾는 방식으로 방어적으로 구현. 실제 키 발급 후 진짜 응답으로 재검증 필요.
- **`fast-xml-parser` 함정**: 기본 설정이 `"00"`처럼 숫자로 보이는 문자열을 자동으로 숫자 `0`으로 바꿔버린다. `resultCode`를 문자열 `"00"`과 그대로 비교하면 항상 실패로 판정되므로 `Number(code) !== 0`으로 비교해야 한다.
- 전국 두수 합계 필드명 미확정이라 `unitCount`는 당분간 항상 `null`.

### 크론 (`app/api/cron/market-price-sync/route.ts`, `vercel.json`)
- Vercel Cron, 매일 04:00 UTC(=13:00 KST, 아침 경매 정산 이후 여유) 1회 호출. Hobby 플랜은 크론 최소 주기가 1일이라 이 스케줄이 최대 빈도.
- KST 기준 오늘 날짜(`Intl.DateTimeFormat` timeZone Asia/Seoul)로 소/돼지 API를 각각 호출해 `market_price_snapshots`에 upsert(service_role, RLS 우회). 축종 하나가 실패해도 다른 쪽은 그대로 반영되고 응답 body의 `results`에 실패 사유만 남김(200 응답 유지 — 크론 모니터링 오탐 방지).
- `CRON_SECRET` 설정 시 Vercel이 자동으로 붙이는 `Authorization: Bearer` 헤더를 검증. 미설정이면 인증 없이 허용(읽기전용 공개 시세 저장뿐이라 낮은 위험으로 판단, 필수 아님).
- API 키 미설정 상태에서 로컬 `next dev`로 직접 호출해 `{"skipped": true, "reason": "KAPE_MARKET_PRICE_API_KEY 미설정"}` 정상 반환 확인함.

### 조회 액션 + UI 위젯
- `app/actions/market-price.ts` `getLatestMarketPricesAction()` — 캐시에서 가장 최근 스냅샷 날짜의 소/돼지 전체 등급을 한 번에 반환. RLS가 `authenticated` 전체에 열려 있어 권한 체크 없음.
- `components/market-price-widget.tsx` `<MarketPriceWidget category="소" />` — 마운트 시 1회 조회, 카테고리(축종) → species 매핑은 "소"→cattle, "돼지"→pig만 지원(그 외 축종은 위젯 자체를 숨김). 상품 등록/수정 폼(`product-form-view.tsx`)의 "원매가 참고란" 안, 입력란 바로 아래에 배치.
- 데이터 없을 때("아직 시세 데이터가 없습니다") 안내 문구 표시 — API 키 미설정 또는 크론 미실행 상태를 사용자에게 자연스럽게 알려줌.

### API 키 등록 + 실데이터 검증 완료 (2026-09-18)
`KAPE_MARKET_PRICE_API_KEY` 발급 완료(data.go.kr 계정 공용키, `NTS_BUSINESS_VERIFY_API_KEY`와 동일 값). `.env.local` + Vercel(Production/Preview/Development) 등록 완료. 로컬에서 크론 엔드포인트 직접 호출로 실데이터 확인함 — 소 11개 등급(1++ 26,980원/kg ~ D등급 8,038원/kg), 돼지 7개 등급(1+ 7,762원/kg, 평균 6,046원/kg) 전부 정상 저장. 파싱 트리 재귀탐색 방식이 실제 응답 구조와 잘 맞는 것으로 확인.

### 주말/휴장일 버그 발견 + 수정 (2026-09-20)
사장님이 "위젯이 API 키 없는 것처럼 동작한다"고 보고. 실제 키로 직접 호출해 원인 확인:
평일엔 정상적으로 `CTotAmt`(가격) 필드가 포함된 응답이 오지만, 경매가 없는 주말/휴장일에
같은 날짜로 조회하면 가격 필드 없이 등급코드표만 돌아온다(9/20 일·9/19 토 0건 확인, 9/18
금·9/17 목은 정상 11건). 기존 크론은 오늘 날짜 하나만 조회하고 끝나서, 배포 후 첫 크론
실행이 주말에 걸리는 바람에 `market_price_snapshots`가 한 번도 안 채워진 것으로 추정 —
결과적으로 위젯은 "API 키 미설정"과 똑같은 화면("시세 데이터 없음")을 보여줬다.

`app/api/cron/market-price-sync/route.ts`의 `syncSpecies`를 오늘부터 최대 6일 전까지
거슬러 올라가며 실제 가격 데이터가 있는 가장 최근 경매일을 찾도록 수정(추석 등 연휴로
여러 날 연속 휴장해도 안전). 실제 API로 로컬 검증 완료.

### 남은 과제
- 전국 두수 합계 필드명 여전히 미확정 — `unit_count`는 실데이터로도 계속 null (API 응답에 해당 필드가 없거나 파싱 로직이 못 찾음, 우선순위 낮음 — 가격만으로도 위젯 목적 충족).
- 상품 등록/수정 화면에서 위젯이 실제로 렌더링되는지 브라우저 육안 확인 — 아직 안 함(API/DB 레벨은 검증 완료, UI 레벨만 남음).
- 다음 크론 실행은 매일 04:00 UTC(13:00 KST) — 이후로는 자동 매일 갱신. 지금 당장 데이터를 채우려면 배포 후 `/api/cron/market-price-sync`를 한 번 직접 호출(브라우저 접속)하면 즉시 최근 경매일(9/18 금) 데이터로 채워진다.
