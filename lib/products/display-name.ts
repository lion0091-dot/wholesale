/**
 * 상품/발주품목의 화면 표시명을 항상 "축종 자유기재이름" 형태로 강제 조합한다.
 *
 * 축종(category)은 등록 시 시스템이 제공하는 선택지에서 고르고 이후 수정도 막혀있는
 * 값인 반면, 상품명(name)은 완전 자유 텍스트다. 표시명을 상품명 하나에만 맡기면
 * 공급사가 "소고기 특수부위" 같은 문구를 상품명에 적어놓고 축종만 몰래 바꿔도
 * 화면상 표기가 그대로 남아 눈치채기 어렵다 — 축종을 항상 앞에 강제로 붙여서
 * 표시명과 실제 축종이 항상 일치해 보이게 한다.
 */
export function composeProductDisplayName(
  category: string | null | undefined,
  name: string
): string {
  return category ? `${category} ${name}` : name;
}
