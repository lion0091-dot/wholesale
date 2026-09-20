/**
 * 상품명 하나로만 된 문자열 필드(PDF 셀, 알림톡/PG 주문명 문구, 목록 요약 텍스트,
 * 삭제 확인 팝업 등 — 별도 배지를 놓을 레이아웃 공간이 없는 곳)에서 축종을 상품명과
 * 시각적으로 구분되게 붙일 때 쓴다. "[축종] 이름"처럼 대괄호로 태그를 달아, 축종이
 * 상품명의 일부인 것처럼 섞여 보이지 않게 한다.
 *
 * 레이아웃에 여유가 있는 화면(장바구니/발주 상세/미니샵 카드 등)은 이 함수를 쓰지
 * 말고 축종을 별도 배지 엘리먼트로 렌더링하고 상품명(product.name)은 그대로 보여줄 것.
 */
export function composeProductDisplayName(
  category: string | null | undefined,
  name: string
): string {
  return category ? `[${category}] ${name}` : name;
}
