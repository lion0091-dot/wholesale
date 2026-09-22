/**
 * Code 128 바코드 생성기 확인.
 *   node scripts/test-code128.mjs
 *
 * 실제 스캐너 판독은 여기서 확인할 수 없다. 표 전사 오류를 잡는 규격
 * 불변식(모든 패턴 11모듈, 정지 13모듈)과 구조만 검사한다.
 */
import { evaluateModules } from "./lib-strip-types.mjs";

const module = "lib/livestock/code128.ts";
const validatePatternTable = evaluateModules([module], "validatePatternTable");
const renderCode128Svg = evaluateModules([module], "renderCode128Svg");
const isEncodableCode128B = evaluateModules([module], "isEncodableCode128B");

let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    console.log(`✅ ${label}${detail ? ` → ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`❌ ${label}${detail ? ` → ${detail}` : ""}`);
  }
};

const problems = validatePatternTable();
check("패턴표 규격 검사 (11/13 모듈)", problems.length === 0, problems.slice(0, 5).join(" | "));

check("숫자 이력번호 인코딩 가능", isEncodableCode128B("002123456789"));
check("한글은 인코딩 불가로 판정", !isEncodableCode128B("한우"));
check("빈 값은 불가", !isEncodableCode128B(""));

const svg = renderCode128Svg("002123456789");
check("SVG 생성됨", typeof svg === "string" && svg.startsWith("<svg"));
check("검정 막대가 그려짐", (svg.match(/<rect[^>]*fill="#000"/g) || []).length > 10);
check("한글은 null 반환", renderCode128Svg("한우") === null);

// 12자리 값: 시작1 + 데이터12 + 검사1 + 정지1 = 15심볼.
// 막대(짝수 인덱스) 개수 = 14심볼 × 3 + 정지 4 = 46
const barCount = (svg.match(/<rect[^>]*fill="#000"/g) || []).length;
check("막대 개수가 심볼 수와 맞음", barCount === 46, String(barCount));

if (failed > 0) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

console.log("\n전부 통과 (실제 스캐너 판독은 미확인)");
