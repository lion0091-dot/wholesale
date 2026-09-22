/**
 * 타입 표기만 걷어내고 모듈을 평가하기 위한 도우미.
 *
 * npm 레지스트리가 이 환경에서 막혀 ts-node/tsx를 설치할 수 없다. 테스트가
 * 필요한 순수 함수 모듈은 타입 표기를 지우고 Function으로 평가해 확인한다.
 * 정규식으로 임의의 TS를 다루는 건 위험하지만, 대상 파일이 타입 표기만 쓰는
 * 순수 함수라 이 범위에서는 안전하다 — 새 문법을 쓰면 여기도 함께 고쳐야 한다.
 */
import { readFileSync } from "node:fs";

const TYPE_PATTERNS = [
  /^import[^;]+;$/gm,
  /export (type|interface)[\s\S]*?\n}\n/g,
  /export type [^;]+;/g,
  /: Record<string, number>/g,
  /: ParsedImport\b/g,
  /: ImportRow\[\]/g,
  /: ImportRow\b/g,
  /: ParsedBarcode\b/g,
  /: Partial<ParsedBarcode>/g,
  /: BarcodeFormat/g,
  /: string \| null/g,
  /: number \| null/g,
  /: string\[\]/g,
  /: string\b/g,
  /: number\b/g,
  /: boolean\b/g,
  /: unknown\b/g,
];

export function stripTypes(path) {
  let source = readFileSync(path, "utf8");

  for (const pattern of TYPE_PATTERNS) {
    source = source.replace(pattern, "");
  }

  return source.replace(/export /g, "");
}

/** 여러 모듈을 이어붙여 평가하고 마지막에 지정한 심볼을 돌려준다. */
export function evaluateModules(paths, exportName) {
  const body = paths.map((path) => stripTypes(path)).join("\n");

  return new Function(`${body}\n; return ${exportName};`)();
}
