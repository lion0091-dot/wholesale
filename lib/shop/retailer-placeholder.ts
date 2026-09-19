/**
 * claim_shop_access()가 상호명 자리에 채워 넣는 자리표시자.
 *
 * "카카오 회원" — 카카오 프로필에 닉네임/이름이 전혀 없을 때 DB 함수(RPC)가 쓰는 값.
 * "고객(소매)" — buyer-auth.ts(requireLinkedBuyer)가 null인 상호명을 화면에 보여줄 때
 * 쓰는 표시용 대체값. 서버 액션(app/shop/[shop_token]/actions.ts)과 클라이언트
 * 컴포넌트(checkout-view.tsx) 양쪽에서 같은 기준으로 "아직 진짜 정보가 아님"을
 * 판정해야 하므로 여기 하나로 모아둔다 — 예전엔 각자 다른 문자열만 확인해서
 * 어긋난 적이 있었다.
 */
const RETAILER_NAME_PLACEHOLDERS = new Set(["카카오 회원", "고객(소매)"]);

export function isRetailerNamePlaceholder(name: string | null | undefined): boolean {
  return !name || RETAILER_NAME_PLACEHOLDERS.has(name);
}
