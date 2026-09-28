/**
 * Code 128 바코드를 SVG로 그린다.
 *
 * bwip-js(BWIPP — 업계에서 오래 검증된 레퍼런스 구현을 포팅한 라이브러리)로 만든다.
 * npm 레지스트리가 막혀 있던 시절엔 이 패턴표를 손으로 옮겨 적어 직접 구현했는데,
 * 실제 스캐너로 읽어본 적이 없는 채로 남아 있었다. 2026-09-23 npm 복구 이후 그
 * 전제가 없어져서, 검증된 구현으로 교체했다(2026-09-28).
 *
 * 소분해서 나가는 봉지에 붙일 라벨용이다 — 이력번호를 눈으로도 읽고 스캐너로도
 * 읽을 수 있어야 재입고·추적이 편하다.
 */

import bwipjs from "bwip-js/node";

export interface Code128Options {
  /** 모듈 하나의 폭(배율, bwip-js의 scale). 2 이상이어야 인쇄 후에도 읽힌다. */
  moduleWidth?: number;
  /** 바 높이(px). bwip-js는 mm 단위를 써서 대략 환산한다(4px ≈ 1mm). */
  height?: number;
}

/**
 * SVG 문자열을 돌려준다. 값이 비었거나 bwip-js가 인코딩에 실패하면 null —
 * 호출부가 바코드 없이 글자만 찍도록 한다.
 */
export function renderCode128Svg(value: string, options: Code128Options = {}): string | null {
  if (!value) {
    return null;
  }

  try {
    return bwipjs.toSVG({
      bcid: "code128",
      text: value,
      scale: options.moduleWidth ?? 2,
      height: (options.height ?? 40) / 4,
      includetext: false,
      backgroundcolor: "FFFFFF",
    });
  } catch {
    return null;
  }
}
