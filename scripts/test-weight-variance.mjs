/**
 * 표기중량 대비 실중량 오차 판정 확인 (의존성 설치 없이 실행).
 *   node scripts/test-weight-variance.mjs
 *
 * DB에도 같은 규칙이 있다(public.inbound_weight_tolerance = 0.02). 둘이 어긋나면
 * "화면은 경고인데 집계에는 안 잡히는" 상태가 되므로 값을 바꿀 때 함께 본다.
 */
import { evaluateModules } from "./lib-strip-types.mjs";

const api = evaluateModules(
  ["lib/livestock/weight-variance.ts"],
  "({ evaluateWeightVariance, formatVarianceRatio, formatVarianceWeight, calcPurchaseAmount, INBOUND_WEIGHT_TOLERANCE })"
);

const cases = [
  {
    label: "표기 20 / 실측 19.8 → -1%, 허용 안",
    run: () => api.evaluateWeightVariance(20, 19.8),
    expect: { variance: -0.2, exceeded: false },
  },
  {
    label: "표기 20 / 실측 19.0 → -5%, 허용 초과",
    run: () => api.evaluateWeightVariance(20, 19),
    expect: { variance: -1, exceeded: true },
  },
  {
    label: "표기보다 많이 와도 초과면 알린다 (+5%)",
    run: () => api.evaluateWeightVariance(20, 21),
    expect: { variance: 1, exceeded: true },
  },
  {
    label: "딱 2%는 허용 (경계는 통과)",
    run: () => api.evaluateWeightVariance(20, 19.6),
    expect: { variance: -0.4, exceeded: false },
  },
  {
    label: "표기중량이 없으면 판정하지 않는다",
    run: () => api.evaluateWeightVariance(null, 19.8),
    expect: null,
  },
  {
    label: "표기중량 0은 판정하지 않는다 (0으로 나누기 방지)",
    run: () => api.evaluateWeightVariance(0, 19.8),
    expect: null,
  },
  {
    label: "g 단위 오차도 살린다 (8.204 - 8.200)",
    run: () => api.evaluateWeightVariance(8.2, 8.204),
    expect: { variance: 0.004, exceeded: false },
  },
];

let failed = 0;

for (const testCase of cases) {
  const result = testCase.run();

  let ok;

  if (testCase.expect === null) {
    ok = result === null;
  } else {
    ok =
      result !== null &&
      Math.abs(result.variance - testCase.expect.variance) < 1e-9 &&
      result.exceeded === testCase.expect.exceeded;
  }

  if (ok) {
    console.log(`✅ ${testCase.label}`);
  } else {
    failed += 1;
    console.log(`❌ ${testCase.label}`);
    console.log(`   기대 ${JSON.stringify(testCase.expect)} / 실제 ${JSON.stringify(result)}`);
  }
}

// 금액은 원 단위로 떨군다 (DB의 GENERATED 컬럼과 같은 계산식)
const amountCases = [
  { weight: 19.8, price: 52000, expect: 1029600 },
  { weight: 8.204, price: 55000, expect: 451220 },
  { weight: 10, price: null, expect: null },
  { weight: 7.333, price: 30000, expect: 219990 },
];

for (const item of amountCases) {
  const result = api.calcPurchaseAmount(item.weight, item.price);

  if (result === item.expect) {
    console.log(`✅ 매입금액 ${item.weight}kg × ${item.price ?? "(단가없음)"} → ${result}`);
  } else {
    failed += 1;
    console.log(`❌ 매입금액 ${item.weight}kg × ${item.price} → 기대 ${item.expect} / 실제 ${result}`);
  }
}

// 표기 형식
const formatChecks = [
  [api.formatVarianceRatio(-0.05), "-5.0%"],
  [api.formatVarianceRatio(0.012), "+1.2%"],
  [api.formatVarianceWeight(-0.2), "-0.200kg"],
  [api.formatVarianceWeight(0.004), "+0.004kg"],
];

for (const [actual, expected] of formatChecks) {
  if (actual === expected) {
    console.log(`✅ 표기 ${actual}`);
  } else {
    failed += 1;
    console.log(`❌ 표기 기대 ${expected} / 실제 ${actual}`);
  }
}

if (api.INBOUND_WEIGHT_TOLERANCE !== 0.02) {
  failed += 1;
  console.log(`❌ 허용 오차가 DB(0.02)와 다릅니다: ${api.INBOUND_WEIGHT_TOLERANCE}`);
}

if (failed > 0) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

console.log("\n전부 통과");
