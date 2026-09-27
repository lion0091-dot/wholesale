import writeExcelFile from "write-excel-file/node";
import { PURCHASE_ORDER_HEADERS, PURCHASE_ORDER_SHEET } from "./lines";

/**
 * 공급처 발주서 입력 양식(.xlsx) — 헤더 한 줄뿐이다(예시 줄을 넣으면 그대로 올라가 진짜 줄이 되므로 예시는 안내 시트에 둔다).
 * 헤더 이름은 lib/purchase-orders/lines.ts의 parsePurchaseOrderCells와 맞다.
 */
const PREFORMATTED_ROWS = 200;
const HEADER_STYLE = { fontWeight: "bold" as const, backgroundColor: "#E2E8F0", align: "center" as const };

export async function buildPurchaseOrderTemplate(categories: readonly string[]): Promise<Buffer> {
  const header = PURCHASE_ORDER_HEADERS.map((value) => ({ value, ...HEADER_STYLE }));
  const blankRows = Array.from({ length: PREFORMATTED_ROWS }, () => PURCHASE_ORDER_HEADERS.map(() => null));

  const guide = [
    [{ value: "공급처 발주서 입력 양식 — 작성 방법", fontWeight: "bold" as const }],
    ["1. '발주서' 시트에 발주할 품목을 한 줄씩 적습니다. 첫 줄(머리글)은 지우지 마세요."],
    [`2. 축종은 ${categories.join(", ")} 중 하나로 적습니다.`],
    ["3. 수량은 kg 단위 숫자입니다. 단가(원/kg)는 비워도 됩니다. 쉼표는 있어도 됩니다."],
    ["4. 공급처 이름과 날짜는 엑셀이 아니라 화면에서 입력합니다."],
    ["5. 다 적었으면 저장한 뒤, 발주서 화면의 '엑셀 올리기'로 이 파일(.xlsx)을 올리세요. 올리면 화면에서 확인·수정한 뒤 저장합니다."],
    [""],
    [{ value: "예시 (이 시트는 올라가지 않습니다)", fontWeight: "bold" as const }],
    [...PURCHASE_ORDER_HEADERS],
    ["소", "등심", "1++", "국내산", "50", "45,000"],
  ];

  return writeExcelFile(
    [
      {
        data: [header, ...blankRows],
        sheet: PURCHASE_ORDER_SHEET,
        columns: [{ width: 12 }, { width: 14 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 14 }],
        stickyRowsCount: 1,
      },
      { data: guide as never, sheet: "작성 안내", columns: [{ width: 100 }] },
    ] as never
  ).toBuffer();
}
