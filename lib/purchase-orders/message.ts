/**
 * 발주서를 카톡 본문에 붙여 넣을 문구로 만든다. 축종별로 묶고 한 줄에 "냉장/냉동 품종 부위 등급(BMS) 성별 원산지 수량"만 적는다.
 * 공급처가 어느 변형을 보내야 하는지 알 수 있도록 성별·BMS·냉장/냉동까지 전부 문구에 실어야 한다(2026-09-30, 사장님 지적 —
 * 예전엔 이 세 칸이 상품에는 있어도 발주 문구엔 빠져서 공급처가 어느 걸 보내야 할지 알 방법이 없었다).
 * BMS는 등급 바로 뒤에 괄호로 붙인다(예: "1++(9)") — 등급·BMS가 한 묶음으로 읽혀야 한다(사장님 지적).
 * 카톡 본문은 표가 없으니 줄이 많아도 읽히게 하는 것이 목적이다. 단가는 옵션이다(선택 입력이라 없는 줄도 있다).
 */
export interface PurchaseOrderMessageInput {
  supplierName: string;
  orderedOn: string;
  expectedOn: string | null;
  note: string | null;
  lines: Array<{
    category: string;
    breed?: string | null;
    subcategory: string | null;
    grade: string | null;
    sex?: string | null;
    bms?: string | null;
    storageState?: string | null;
    origin: string;
    quantity: number;
    unit: string;
    unitPrice: number | null;
  }>;
}

/** 2026-09-27 → 9/27 */
function shortDate(value: string): string {
  const matched = value.match(/^\d{4}-(\d{2})-(\d{2})$/);

  return matched ? `${Number(matched[1])}/${Number(matched[2])}` : value;
}

function amount(value: number): string {
  return Number(value.toFixed(2)).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

export function buildPurchaseOrderMessage(order: PurchaseOrderMessageInput, options: { includePrice?: boolean } = {}): string {
  const dates = [`발주일 ${shortDate(order.orderedOn)}`, order.expectedOn ? `도착 예정 ${shortDate(order.expectedOn)}` : null].filter(Boolean).join(" · ");
  const groups = new Map<string, string[]>();

  for (const line of order.lines) {
    const gradeWithBms = line.bms ? `${line.grade ?? ""}(${line.bms})` : line.grade;
    const spec = [line.storageState, line.breed, line.subcategory, gradeWithBms, line.sex, line.origin]
      .filter(Boolean)
      .join(" ");
    const price = options.includePrice && line.unitPrice !== null ? ` · ${amount(line.unitPrice)}원/${line.unit}` : "";
    const rows = groups.get(line.category) ?? [];

    rows.push(`- ${spec} ${amount(line.quantity)}${line.unit}${price}`);
    groups.set(line.category, rows);
  }

  const total = order.lines.reduce((sum, line) => sum + line.quantity, 0);
  const units = new Set(order.lines.map((line) => line.unit));
  const parts = [`[발주] ${order.supplierName} 귀중`, dates, ""];

  for (const [category, rows] of groups) {
    parts.push(`■ ${category}`, ...rows);
  }

  parts.push("", `합계 ${amount(total)}${units.size === 1 ? [...units][0] : ""}`);

  if (order.note?.trim()) {
    parts.push(`※ ${order.note.trim()}`);
  }

  return parts.join("\n");
}
