import writeExcelFile from "write-excel-file/node";

/**
 * 공급처 명세서 입력 양식(.xlsx) — 종이·팩스로 받은 명세서를 사무실에서 옮겨 적는 빈 엑셀.
 *
 * 첫 시트 "명세서"는 헤더 한 줄뿐이다(예시 줄을 넣으면 그대로 올라가 진짜 줄이 되므로 예시는 안내 시트에 둔다).
 * 헤더 이름은 lib/livestock/document-parser.ts의 칸 추측 패턴과 맞춰 올리면 칸이 저절로 잡힌다.
 * 이력번호·묶음번호 칸은 텍스트 서식이다 — 일반 서식이면 엑셀이 앞 0을 지우고 12자리를 2.12E+11처럼 보여 준다.
 */
export const STATEMENT_TEMPLATE_SHEET = "명세서";
export const STATEMENT_TEMPLATE_HEADERS = ["품목", "부위", "등급", "원산지", "이력번호", "묶음번호", "수량", "중량", "단가", "금액"] as const;

/** 텍스트 서식을 미리 걸어 둘 데이터 줄 수 — 이보다 많이 적는 명세서는 드물다. */
const PREFORMATTED_ROWS = 300;
const TEXT_COLUMNS = new Set(["이력번호", "묶음번호"]);

const HEADER_STYLE = { fontWeight: "bold" as const, backgroundColor: "#E2E8F0", align: "center" as const };

export async function buildStatementTemplate(): Promise<Buffer> {
  const header = STATEMENT_TEMPLATE_HEADERS.map((value) => ({ value, ...HEADER_STYLE }));
  const blankRows = Array.from({ length: PREFORMATTED_ROWS }, () =>
    STATEMENT_TEMPLATE_HEADERS.map((name) => (TEXT_COLUMNS.has(name) ? { value: "", type: String, format: "@" } : null))
  );

  const guide = [
    [{ value: "공급처 명세서 입력 양식 — 작성 방법", fontWeight: "bold" as const }],
    ["1. '명세서' 시트에 종이 명세서의 줄을 한 줄씩 옮겨 적습니다. 첫 줄(헤더)은 지우지 마세요."],
    ["2. 이력번호는 12자리 숫자입니다. 칸이 텍스트 서식이라 앞의 0도 그대로 남습니다."],
    ["3. 부위 칸을 채우면 입고할 때 상품이 부위 이름으로 만들어집니다. 비워 두면 '(부위 미지정)' 상품이 됩니다."],
    ["4. 수량은 박스 수입니다(비우면 1박스). 중량은 kg, 단가는 원/kg, 금액은 원입니다. 쉼표는 있어도 됩니다."],
    ["5. 묶음번호 칸은 이력번호와 묶음번호가 둘 다 적힌 명세서에서만 씁니다. 묶음번호만 있으면 이력번호 칸에 적으세요."],
    ["6. 다 적었으면 저장한 뒤, 입고 화면의 '파일 고르기'에서 이 파일(.xlsx)을 그대로 올리세요."],
    [""],
    [{ value: "예시 (이 시트는 올라가지 않습니다)", fontWeight: "bold" as const }],
    ["품목", "부위", "등급", "원산지", "이력번호", "묶음번호", "수량", "중량", "단가", "금액"],
    ["한우 안심", "안심", "1++", "국내산", "002123456781", "", "1", "7.1", "90,000", "639,000"],
  ];

  return writeExcelFile(
    [
      { data: [header, ...blankRows], sheet: STATEMENT_TEMPLATE_SHEET, columns: [{ width: 22 }, { width: 12 }, { width: 8 }, { width: 10 }, { width: 18 }, { width: 18 }, { width: 8 }, { width: 10 }, { width: 12 }, { width: 14 }], stickyRowsCount: 1 },
      { data: guide as never, sheet: "작성 안내", columns: [{ width: 110 }] },
    ] as never
  ).toBuffer();
}
