/**
 * 미니샵 초대장(카카오톡 발송 문구) 템플릿.
 *
 * 초대장은 이 서비스의 핵심 영업 행위다. 승인 전 공급사에게는 발부가 차단되므로
 * shop_token 이 필요한 문구 생성은 전부 서버(app/actions/invite.ts)에서만 수행하고,
 * 클라이언트에는 완성된 문구/링크만 전달한다.
 */

export interface InviteMessageInput {
  wholesalerName: string;
  shopUrl: string;
  /** 특정 바이어에게 보내는 초대장이면 상호를 넣어 1:1 문구로 만든다. */
  customerName?: string | null;
}

export function buildInviteMessage({
  wholesalerName,
  shopUrl,
  customerName,
}: InviteMessageInput): string {
  const footer = `👉 발주 링크: ${shopUrl}
(스마트폰 브라우저 메뉴에서 '홈 화면에 추가'해 두시면 매일 편리하게 주문하실 수 있습니다.)`;

  if (customerName) {
    return `[${customerName} 사장님 전용 모바일 발주서 안내]

안녕하세요, ${wholesalerName}입니다.
${customerName} 사장님의 빠르고 편리한 육류 발주를 위해 1:1 모바일 미니샵을 준비했습니다.

아래 전용 초대 링크에서 당일 품목과 사장님께만 적용되는 맞춤 단가·핫딜 특가를 확인하시고 간편하게 발주서를 보내주세요!

${footer}`;
  }

  return `[단골 거래처 모바일 발주서 안내]

안녕하세요, ${wholesalerName}입니다.
고객(소매) 사장님들의 빠르고 편리한 육류 발주를 위해 1:1 모바일 미니샵을 오픈했습니다.

아래 전용 초대 링크를 통해 당일 고기 품목과 단골 전용 핫딜 특가를 확인하시고 간편하게 발주서를 보내주세요!

${footer}`;
}
