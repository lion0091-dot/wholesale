/**
 * 품목명("한우 등심", "국내산 삼겹살")에서 부위를 뽑는다 — 전표에 부위 칸이 없거나 비어 있을 때만 쓴다.
 * 사전에 있는 부위가 품목명에 정확히 하나만(가장 긴 이름 기준) 들어 있을 때만 돌려준다. 둘 이상이거나 없으면 null이라 사람이 고른다.
 */
const PART_NAMES = [
  // 소
  "꽃등심", "알등심", "등심", "채끝", "안심", "목심", "앞다리", "우둔", "설도", "홍두깨", "보섭살", "부채살", "살치살", "토시살",
  "제비추리", "치마살", "업진살", "차돌박이", "우삼겹", "아롱사태", "양지", "사태", "갈비살", "갈비", "다짐육", "사골", "꼬리",
  // 돼지
  "삼겹살", "목살", "앞다리살", "뒷다리살", "뒷다리", "항정살", "가브리살", "갈매기살", "등갈비", "족발", "껍데기",
  // 닭·오리
  "통닭", "다리살", "가슴살", "날개", "오리훈제",
  // 양
  "양갈비", "양다리", "양등심", "통양",
  // 가공육
  "소시지", "베이컨", "육포", "순대",
].sort((a, b) => b.length - a.length);

export function partNameFromItemName(itemName: string | null | undefined): string | null {
  const text = (itemName ?? "").replace(/\s+/g, "");

  if (!text) return null;

  // 긴 이름부터 찾고, 찾은 자리는 지워 그 안의 짧은 이름(꽃등심 속 등심)이 또 잡히지 않게 한다.
  let rest = text;
  const found = new Set<string>();

  for (const part of PART_NAMES) {
    if (rest.includes(part)) {
      found.add(part);
      rest = rest.split(part).join("·");
    }
  }

  return found.size === 1 ? [...found][0] : null;
}
