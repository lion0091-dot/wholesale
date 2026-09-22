/**
 * Code 128-B 바코드를 SVG로 그린다.
 *
 * npm 레지스트리가 이 환경에서 막혀 바코드 라이브러리를 넣을 수 없어 직접 만든다.
 * 소분해서 나가는 봉지에 붙일 라벨용이다 — 이력번호를 눈으로도 읽고 스캐너로도
 * 읽을 수 있어야 재입고·추적이 편하다.
 *
 * ⚠️ 실제 스캐너로 읽어본 적이 없다. 표 전사 오류를 잡으려고 "모든 패턴은
 *    11모듈(정지 패턴만 13)"이라는 규격 불변식을 코드에서 검사하지만, 그게
 *    실제 판독을 보장하지는 않는다. 현장 배포 전에 스캐너로 한 장 찍어볼 것.
 *    바코드가 안 읽혀도 라벨에는 이력번호가 큰 글자로 함께 찍히므로,
 *    법정 표시(이력번호 표기) 자체는 충족된다.
 */

/** 값 0~102는 데이터, 103~105는 시작 문자, 106은 정지 패턴. 각 숫자는 바/공백 폭. */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131",
  "211412", // 103 Start A
  "211214", // 104 Start B
  "211232", // 105 Start C
  "2331112", // 106 Stop
];

const START_B = 104;
const STOP = 106;

/**
 * 규격 불변식 검사 — 데이터/시작 패턴은 11모듈, 정지 패턴은 13모듈이다.
 * 표를 옮겨 적다 틀리면 여기서 걸린다.
 */
export function validatePatternTable(): string[] {
  const problems: string[] = [];

  PATTERNS.forEach((pattern, index) => {
    const expectedLength = index === STOP ? 7 : 6;
    const expectedModules = index === STOP ? 13 : 11;

    if (pattern.length !== expectedLength) {
      problems.push(`${index}: 자릿수 ${pattern.length} (기대 ${expectedLength})`);
      return;
    }

    const modules = pattern.split("").reduce((sum, digit) => sum + Number(digit), 0);

    if (modules !== expectedModules) {
      problems.push(`${index}: 모듈 합 ${modules} (기대 ${expectedModules})`);
    }
  });

  if (PATTERNS.length !== 107) {
    problems.push(`표 길이 ${PATTERNS.length} (기대 107)`);
  }

  return problems;
}

/** Code 128-B가 표현할 수 있는 범위인지 (아스키 32~126). */
export function isEncodableCode128B(value: string): boolean {
  return value.length > 0 && [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code <= 126;
  });
}

/** 값 목록 → 바/공백 폭 배열. 짝수 번째가 바, 홀수 번째가 공백이다. */
function toBarWidths(value: string): number[] {
  const codes = [START_B];

  for (const char of value) {
    codes.push(char.charCodeAt(0) - 32);
  }

  // 검사 문자: 시작값 + Σ(자리번호 × 값), 103으로 나눈 나머지.
  let checksum = START_B;

  for (let index = 1; index < codes.length; index += 1) {
    checksum += codes[index] * index;
  }

  codes.push(checksum % 103);
  codes.push(STOP);

  return codes.flatMap((code) => PATTERNS[code].split("").map(Number));
}

export interface Code128Options {
  /** 모듈 하나의 폭(px). 2 이상이어야 인쇄 후에도 읽힌다. */
  moduleWidth?: number;
  height?: number;
}

/**
 * SVG 문자열을 돌려준다. 읽을 수 없는 값이면 null —
 * 호출부가 바코드 없이 글자만 찍도록 한다.
 */
export function renderCode128Svg(value: string, options: Code128Options = {}): string | null {
  if (!isEncodableCode128B(value)) {
    return null;
  }

  const moduleWidth = options.moduleWidth ?? 2;
  const height = options.height ?? 48;

  const widths = toBarWidths(value);
  // 조용한 여백(quiet zone) — 앞뒤로 10모듈 이상 비워야 스캐너가 시작을 찾는다.
  const quietZone = 10;

  let x = quietZone;
  const bars: string[] = [];

  widths.forEach((width, index) => {
    if (index % 2 === 0) {
      bars.push(
        `<rect x="${x * moduleWidth}" y="0" width="${width * moduleWidth}" height="${height}" fill="#000"/>`
      );
    }

    x += width;
  });

  const totalWidth = (x + quietZone) * moduleWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" viewBox="0 0 ${totalWidth} ${height}" shape-rendering="crispEdges"><rect width="${totalWidth}" height="${height}" fill="#fff"/>${bars.join("")}</svg>`;
}
