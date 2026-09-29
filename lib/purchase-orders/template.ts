import writeExcelFile from "write-excel-file/node";
import { PURCHASE_ORDER_HEADERS, PURCHASE_ORDER_SHEET } from "./lines";
import { CATTLE_BREEDS, CATTLE_GRADES, CATTLE_SEXES, BMS_VALUES, STORAGE_STATES, ORIGIN_OPTIONS } from "./spec-options";

/**
 * 공급처 발주서 입력 양식(.xlsx) — 헤더 한 줄뿐이다(예시 줄을 넣으면 그대로 올라가 진짜 줄이 되므로 예시는 안내 시트에 둔다).
 * 헤더 이름은 lib/purchase-orders/lines.ts의 parsePurchaseOrderCells와 맞다.
 */
const PREFORMATTED_ROWS = 200;
const HEADER_STYLE = { fontWeight: "bold" as const, backgroundColor: "#E2E8F0", align: "center" as const };

export async function buildPurchaseOrderTemplate(
  categories: readonly string[],
  subcategoriesByCategory: Readonly<Record<string, readonly string[]>> = {}
): Promise<Buffer> {
  const header = PURCHASE_ORDER_HEADERS.map((value) => ({ value, ...HEADER_STYLE }));
  const blankRows = Array.from({ length: PREFORMATTED_ROWS }, () => PURCHASE_ORDER_HEADERS.map(() => null));

  const listRows = categories.map((category) => [category, (subcategoriesByCategory[category] ?? []).join(", ")]);
  const listSheet = [
    [{ value: "선택 목록 — 표에 있는 이름 그대로 적어야 합니다", fontWeight: "bold" as const }],
    [{ value: "축종", fontWeight: "bold" as const }, { value: "부위 (소·돼지는 이 중에서만)", fontWeight: "bold" as const }],
    ...listRows,
    [""],
    [{ value: "소 품종 (국내산 소는 반드시 이 중에서)", fontWeight: "bold" as const }, CATTLE_BREEDS.join(", ")],
    [{ value: "소 등급 (소는 이 중에서만)", fontWeight: "bold" as const }, CATTLE_GRADES.join(", ")],
    [{ value: "소 성별 (국내산 소는 반드시 이 중에서)", fontWeight: "bold" as const }, CATTLE_SEXES.join(", ")],
    [{ value: "원산지 (소·돼지·닭·오리·계란은 이 중에서만)", fontWeight: "bold" as const }, ORIGIN_OPTIONS.join(", ")],
    [{ value: "냉장/냉동 (소·돼지·닭·오리는 반드시 이 중에서)", fontWeight: "bold" as const }, STORAGE_STATES.join(", ")],
    [{ value: "BMS (소 1++ 등급만, 비워도 됨)", fontWeight: "bold" as const }, BMS_VALUES.join(", ")],
  ];

  const guide = [
    [{ value: "공급처 전표 입력 양식 — 작성 방법", fontWeight: "bold" as const }],
    ["1. '전표' 시트에 발주할 품목을 한 줄씩 적습니다. 첫 줄(머리글)은 지우지 마세요."],
    [`2. 축종은 ${categories.join(", ")} 중 하나로 적습니다.`],
    ["3. 품종·부위·등급·성별·원산지·냉장/냉동·BMS는 '선택 목록' 시트의 이름 그대로 적습니다. 국내산 소는 품종·성별이 필수, 소·돼지·닭·오리는 냉장/냉동이 필수입니다. BMS는 소 1++ 등급일 때만 쓰고 그 밖에는 비워둡니다."],
    ["4. 수량은 kg 단위 숫자입니다. 단가(원/kg)는 비워도 됩니다. 쉼표는 있어도 됩니다."],
    ["5. 공급처 이름과 날짜는 엑셀이 아니라 화면에서 입력합니다."],
    ["6. 다 적었으면 저장한 뒤, 전표 화면의 '엑셀 올리기'로 이 파일(.xlsx)을 올리세요. 올리면 화면에서 확인·수정한 뒤 저장합니다."],
    [""],
    [{ value: "예시 (이 시트는 올라가지 않습니다)", fontWeight: "bold" as const }],
    [...PURCHASE_ORDER_HEADERS],
    ["소", "한우", "등심", "1++", "거세", "국내산", "냉장", "9", "50", "45,000"],
  ];

  return writeExcelFile(
    [
      {
        data: [header, ...blankRows],
        sheet: PURCHASE_ORDER_SHEET,
        columns: [
          { width: 12 },
          { width: 10 },
          { width: 14 },
          { width: 10 },
          { width: 8 },
          { width: 12 },
          { width: 10 },
          { width: 8 },
          { width: 12 },
          { width: 14 },
        ],
        stickyRowsCount: 1,
      },
      { data: guide as never, sheet: "작성 안내", columns: [{ width: 100 }] },
      { data: listSheet as never, sheet: "선택 목록", columns: [{ width: 40 }, { width: 90 }] },
    ] as never
  ).toBuffer();
}
