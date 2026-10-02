# 자동 작업(크론) 상태 확인 — `/admin/cron-health`

2026-10-02 추가(마이그 204). 슈퍼관리자 전용 화면, 사이드바 "자동 작업 상태".

## 왜 만들었나

- Vercel 크론은 **실패해도 재시도하지 않는다.** 일시적 네트워크 오류로 호출 자체가 안 가면 **런타임 로그도 남지 않는다**(Vercel 문서 "Cron job delivery"). 그래서 로그만 봐서는 "안 돈 것"을 알 수 없다.
- Vercel **Alerts**는 Pro + Observability Plus(유료 추가)가 필요하고, 함수 에러율 급증만 감지한다. 하루 1번 도는 크론 하나의 실패·누락은 못 잡는다.
- 그래서 크론이 끝날 때마다 DB에 한 줄을 남기고(`cron_runs`), 화면이 "예정 주기보다 오래 성공이 없으면" 빨간색으로 보여준다. 실패와 누락을 둘 다 잡고 추가 비용이 없다.

## 구조

| 요소 | 위치 | 역할 |
|---|---|---|
| 표 | `cron_runs` (마이그 204) | 작업당 1행: `last_run_at`, `last_ok_at`, `last_status`, `last_detail`. 쓰기는 service_role만, 조회는 슈퍼관리자만(RLS). |
| 래퍼 | `lib/cron/heartbeat.ts` `withCronHeartbeat` | 각 크론 라우트의 핸들러를 감싸 결과(HTTP 상태)를 기록. **401(인증 실패)은 기록하지 않는다**(외부 호출이 성공 시각을 흉내/덮어쓰기 못 하게). 실패 때는 `last_ok_at`을 건드리지 않아 "마지막 성공"이 보존된다. 기록 실패는 삼키고 크론 본 작업 결과는 안 바꾼다. |
| 기준표 | `lib/cron/heartbeat.ts` `CRON_JOBS` | 작업별 라벨·허용 시간(`maxAgeHours`). |
| 판정 | `evaluateCronHealth` | `ok` / `failing`(최근 실행이 2xx 아님) / `stale`(마지막 성공이 기준보다 오래됨) / `never`(기록 없음, 회색). |
| 화면 | `app/admin/cron-health/page.tsx` | 카드 목록, 문제 건수 요약. |
| 테스트 | `lib/cron/heartbeat.test.ts` | 판정 5건 + **`vercel.json` 크론 목록과 `CRON_JOBS` 일치** + **모든 크론 라우트가 래퍼를 쓰는지**. |

**새 크론을 추가할 때:** ① `vercel.json`에 등록 ② 라우트를 `async function handler` + `export const GET = withCronHeartbeat("폴더명", handler)`로 작성(인증 코드는 라우트 안에 그대로 둔다 — `service-role-usage.test.ts`가 검사) ③ `CRON_JOBS`에 한 줄 추가. 빠뜨리면 테스트가 실패한다.

## 작업별 기준과 "죽으면 곤란한 것"

| 작업 (`vercel.json`) | 주기 | 빨간색 기준 | 안 돌면 생기는 일 |
|---|---|---|---|
| `check-tenant-consistency` | 매일 | 36시간 | 공급사 간 데이터 섞임(마이그 200 가드를 뚫은 것)을 못 잡는다. **실패 = 실제 섞임 발견일 수 있어 가장 급함.** |
| `reconcile-pg-payments` | 매일 | 36시간 | 결제는 승인됐는데 콜백이 유실된 주문이 복구되지 않는다(돈은 나갔는데 주문이 없음). |
| `finalize-subscription-invoices` | 매월 1일 | 33일 | 그 달 구독료 청구서가 확정되지 않는다. 멱등이라 늦게 돌아도 다시 확정된다. |
| `purge-unconsented-accounts` | 매일 | 36시간 | 가입 미완료 30일 계정이 안 지워진다 — 개인정보처리방침 3조 약속 위반. |
| `purge-expired-personal-data` | 매주 일 | 8일 | 탈퇴 5년 경과 개인정보가 파기되지 않는다(보관기간 5년은 대표 결정, 법률 확인 전). |
| `expire-retailer-invites` | 매일 | 36시간 | 30일 지난 초대(손님 전화번호)가 계속 보관된다 — 목적 달성 후 보관 금지 원칙 위반. |
| `retry-trace-lookups` | 매일 | 36시간 | 이력조회에 실패한 박스가 아침에 자동으로 채워지지 않는다(입고 화면에서 직접 재조회하면 됨). |
| `market-price-sync` | 매일 | 36시간 | 상품 등록 화면의 경락가 위젯이 오래된 값을 보여준다(참고용이라 영향 작음). |

## 이상이 보일 때 조치

**실패(빨강)** — 최근 실행이 오류. 카드 아래 빨간 글씨가 오류 내용이다.
1. 그 내용을 Claude에게 보여주거나, Vercel → Settings → Cron Jobs → 해당 작업 **View Logs**로 확인.
2. 원인을 고친 뒤 다음 예정 시각에 성공으로 바뀌는지 본다(`CRON_SECRET` 헤더가 필요해 브라우저로 직접 호출은 안 된다).
3. **`check-tenant-consistency` 실패는 크론 고장이 아니라 실제 섞임일 수 있다.** 새 데이터를 넣지 말고 [tenant-isolation-runbook.md](tenant-isolation-runbook.md)의 복구 순서로 처리한다.

**오래 안 돎(빨강)** — 마지막 실행은 성공이었는데 그 뒤로 호출이 없다.
1. Vercel Settings → Cron Jobs에 해당 작업이 등록돼 있는지, 최신 배포가 Ready인지 확인.
2. 등록돼 있으면 일시적 누락일 수 있다. 하루 더 보고, 이틀째 계속되면 조사.

**기록 없음(회색)** — 마이그 204 적용 직후이거나 아직 한 번도 안 돈 상태. 다음 예정 시각이 지나면 사라진다. 하루가 지나도 그대로면 기록 코드 누락을 의심.

## 한계·미결정

- **알림이 가지 않는다.** 화면을 열어봐야 보인다. 빨간 상태일 때 슈퍼관리자에게 알림톡/웹푸시를 보낼지는 미결정(안 만듦).
- 운영 DB에 마이그 204를 적용해야 동작한다. 적용 전에는 `cron_runs` 표가 없어 기록이 조용히 건너뛰어지고, 크론 본 작업은 영향이 없다.
- 로컬에서 표 RLS(비관리자 0행, anon 거부)만 확인했다. 크론이 실제로 `cron_runs`에 쓰는 것, 화면 렌더링은 실행 검증 전.
- `maxAgeHours`는 주기보다 여유를 둔 값이다(하루 1회 지연은 허용, 이틀째 빠지면 이상).
