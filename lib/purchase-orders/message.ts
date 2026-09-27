/**
 * 발주서를 카톡 본문에 붙여 넣을 문구로 만든다. 축종별로 묶고 한 줄에 "부위 등급 원산지 수량"만 적는다.
 * 카톡 본문은 표가 없으니 줄이 많아도 읽히게 하는 것이 목적이다. 단가는 옵션이다(선택 입력이라 없는 줄도 있다).
 */
export interface PurchaseOrderMessageInput {
  supplierName: string;
  orderedOn: string;
  expectedOn: string | null;
  note: string | null;
  lines: Array<{
    category: string;
    subcategory: string | null;
    grade: string | null;
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
    const spec = [line.subcategory, line.grade, line.origin].filter(Boolean).join(" ");
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
