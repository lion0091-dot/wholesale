# Downloads 폴더 패치 3개 — 검토 결과 및 최종 폐기

`C:\Users\PC\Downloads\drive-download-20260916T123305Z-1-001\` 에 있던 이전 세션(2026-09-15~16) 산출물 패치 3개를 검토했다. 세 개 모두 **stale**로 판정하여 적용하지 않는다.

**2026-09-22 재검토:** 같은 3개 파일이 `drive-download-20260922T105003Z-1-001\`로 재다운로드되어 다시 확인 요청이 들어옴 — zip 바이트까지 동일한 파일(diff 없음). Vercel 배포는 이미 완료된 상태(`vercel-deployment-live.md`)에서 재검토했고, 아래 판정 사유가 여전히 유효함을 확인. 세 패치 모두 최종 폐기 — 더 이상 재검토하지 않음.

## 1. `0001-docs-8.patch` — PRD 8번 섹션 / ROADMAP 6,7번 추가

- 외상거래(여신) 및 세금계산서 도우미를 "설계만 존재, 미구현"으로 추가하는 문서 패치.
- **보류 사유:** 현재 리포에는 이미 구현이 반영돼 있음.
  - `ROADMAP.md` §6: "외상거래(여신) 관리 (1~5 구현 완료, 자동 스케줄링은 별도 미착수)" — 체크리스트 대부분 `[x]`.
  - `b2b-meat-saas-prd.md` §8만 여전히 "design only... No schema/code exists yet"로 남아 stale.
- 패치를 그대로 적용하면 이미 구현된 기능을 "미구현"으로 되돌리는 꼴이 됨.

## 2. `0002-chore-wholesaler-orders-wholesaler-products-10.patch` — 구버전 화면 삭제

- `app/wholesaler/orders/*`, `app/wholesaler/products/*` (죽은 코드) 삭제하는 패치.
- **보류 사유:** 이미 적용된 상태. 해당 디렉터리가 현재 리포에 존재하지 않고, `/dashboard/orders`, `/dashboard/products`가 대체 화면으로 이미 자리잡음. 어디서도 옛 경로 참조 없음.

## 3. `0003-docs-KNOWN_GAPS.md.patch` — `KNOWN_GAPS.md` 신규 생성

- 오픈 전 미해결 이슈 정리 문서 신규 생성 패치. 리포에 `KNOWN_GAPS.md`는 아직 없음.
- **보류 사유:** 내용 중 다수가 이미 stale.
  - 항목 4 "알림톡 실발송 미구현, 콘솔 로그만 찍는 목업" → `lib/notifications/alimtalk.ts`에 `ALIMTALK_API_KEY`/`ALIMTALK_SENDER_PHONE` 기반 실발송 분기 및 `sendReceivablesReminderToRetailer` 등 이미 추가됨.
  - 항목 7, 8 "외상거래/세금계산서 설계만 있고 미구현" → 위 1번과 동일하게 이미 구현된 상태와 어긋남.
- 그대로 생성하면 오히려 오래된 정보를 새 문서로 고정시키는 셈이라 보류.

## 결론 (2026-09-22 확정)

- 패치 1(PRD/ROADMAP): PRD/ROADMAP은 이미 최신 상태이므로 적용 안 함 (필요하면 PRD §8 상단 stale 문구만 별도로 고칠 것).
- 패치 2(구버전 화면 삭제): 재적용 불필요 (이미 반영됨).
- 패치 3(KNOWN_GAPS.md): 내용 다수가 stale이라 생성 안 함. `KNOWN_GAPS.md`가 필요하면 현재 코드 기준으로 처음부터 새로 작성할 것 — 이 패치를 베이스로 쓰지 말 것. PG(토스페이먼츠)는 코드는 완료됐고 계정 미발급만 남은 상태(`pg-tosspayments-integration.md`), 다른 항목들도 세션 진행에 따라 계속 바뀌므로 그때그때 최신 memory로 확인.
- 세 패치 파일과 다운로드 zip은 더 이상 필요 없음 — Downloads 폴더에서 삭제해도 무방.
