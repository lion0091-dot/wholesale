# 공급사 대시보드 "지금 할 일" 카드 (가입 → 승인 → 첫 고객 초대) — 2026-10-02

카카오 채널이 없어 승인 결과를 알림톡으로 못 보내고, 국세청 대조가 "불일치"여도 공급사는 몰랐다(어드민만 봄). 대시보드 맨 위 파란 카드 하나가 다음 할 일을 알려 준다. 입고·상품 관리 카드와 같은 원칙(하나만 강조, 할 일 없으면 숨김).

- 판단: `lib/supplier/onboarding-next-step.ts`(순수 함수) + `onboarding-next-step.test.ts`(상태 표). 그리기: `components/onboarding-next-step-card.tsx`. 연결: `app/dashboard/page.tsx` 맨 위.
- 우선순위: 거절 → 일시정지 → (미승인) 번호 없음 → 개업일자 없음 → 국세청 불일치/미등록 → 심사 중 → (승인) 승인 대기 손님 → 첫 고객 초대 → 카드 없음. 국세청 API 오류(error)는 공급사 잘못이 아니라 "심사 중"으로 본다.
- 대표·매니저에게만 보인다(직원은 사업자 정보를 못 고침). 슈퍼관리자가 업체를 감독 열람할 때는 안 보인다.
- 카드가 있으면 기존 "승인 심사 진행 중" 배너는 숨긴다(두 가지를 동시에 말하지 않게). 카드가 null일 때만 배너가 그대로 쓰인다.
- 버튼은 앵커로 바로 이동: `/dashboard/invites#business-info`·`#business-license`, `/dashboard#invite-link`, `/dashboard/customers?status=pending_review`(고객 관리가 이 쿼리를 처음 걸 필터로 받도록 추가).
- `SupplierAccount`에 `ntsVerificationStatus`(wholesalers.nts_verification_status) 추가. DB 변경 없음.

확인: 로컬 브라우저에서 국세청 불일치 카드·번호 미제출 카드·버튼 이동(앵커 스크롤)을 눌러 확인. 승인 직후 카드가 즉시 바뀌지는 않는다(다음 이동·새로고침 때 반영). 운영 화면 확인 전.

다음 후보(미착수): 어드민 공급사 승인 "처리할 건" 카드 → 전표관리·보류함 카드.
