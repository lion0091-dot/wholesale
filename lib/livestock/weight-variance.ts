/**
 * 표기중량(바코드·라벨) 대비 실중량(저울) 오차 판정.
 *
 * DB에도 같은 규칙이 있다(`public.inbound_weight_tolerance()`). 화면은 저장 전에
 * 미리 보여주려고 여기서 한 번 더 계산한다 — 두 값이 어긋나면 "화면은 경고인데
 * 집계에는 안 잡히는" 상태가 되므로 바꿀 때 같이 바꿔야 한다.
 */

/** 이 비율까지는 정상으로 본다. 축산 박스는 수분 증발만으로도 조금씩 준다. */
export const INBOUND_WEIGHT_TOLERANCE = 0.02;

export interface WeightVariance {
  /** 실중량 - 표기중량. 음수면 덜 왔다. */
  variance: number;
  /** 표기중량 대비 비율 (-0.05 = 5% 부족) */
  ratio: number;
  /** 허용 오차를 넘었나 */
  exceeded: boolean;
}

/** 표기중량이 없으면(바코드에 안 실려 있으면) 판정하지 않는다 — null을 돌려준다. */
export function evaluateWeightVariance(
  labeledWeight: number | null | undefined,
  actualWeight: number | null | undefined
): WeightVariance | null {
  if (
    labeledWeight === null ||
    labeledWeight === undefined ||
    !Number.isFinite(labeledWeight) ||
    labeledWeight <= 0 ||
    actualWeight === null ||
    actualWeight === undefined ||
    !Number.isFinite(actualWeight)
  ) {
    return null;
  }

  const variance = Number((actualWeight - labeledWeight).toFixed(3));
  const ratio = variance / labeledWeight;

  return {
    variance,
    ratio,
    exceeded: Math.abs(ratio) > INBOUND_WEIGHT_TOLERANCE,
  };
}

/** "-1.0%" 처럼 부호를 붙여 보여준다. */
export function formatVarianceRatio(ratio: number): string {
  const percent = ratio * 100;

  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

/** "-0.200kg" — 0도 부호 없이 그대로 보여준다(차이 없음이 사실이므로). */
export function formatVarianceWeight(variance: number): string {
  return `${variance > 0 ? "+" : ""}${variance.toFixed(3)}kg`;
}

/** 실중량 × 단가를 원 단위로 떨군다. DB의 GENERATED 컬럼과 같은 계산식이다. */
export function calcPurchaseAmount(
  actualWeight: number | null | undefined,
  unitPrice: number | null | undefined
): number | null {
  if (
    actualWeight === null || actualWeight === undefined || !Number.isFinite(actualWeight) ||
    unitPrice === null || unitPrice === undefined || !Number.isFinite(unitPrice)
  ) {
    return null;
  }

  return Math.round(actualWeight * unitPrice);
}
