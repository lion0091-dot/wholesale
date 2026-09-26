const fs = require("fs");
const d = require("docx");
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, HeadingLevel, LevelFormat, BorderStyle, Footer, PageNumber } = d;

const FONT = "Malgun Gothic";
const W = 9638; // content width (A4, 2cm margins)

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: 22, ...o });
const P = (text, o = {}) => new Paragraph({ spacing: { after: 120, line: 320 }, ...o, children: Array.isArray(text) ? text : [run(text)] });
const B = (text) => new Paragraph({ numbering: { reference: "bul", level: 0 }, spacing: { after: 60, line: 300 }, children: Array.isArray(text) ? text : [run(text)] });
const N = (text, ref = "num") => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 80, line: 300 }, children: Array.isArray(text) ? text : [run(text)] });
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 }, children: [new TextRun({ text: t, font: FONT, size: 30, bold: true })] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, font: FONT, size: 25, bold: true })] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 100 }, children: [new TextRun({ text: t, font: FONT, size: 23, bold: true })] });
const bold = (t) => run(t, { bold: true });

const border = { style: BorderStyle.SINGLE, size: 4, color: "94A3B8" };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(text, width, o = {}) {
  const parts = Array.isArray(text) ? text : [run(text, o.bold ? { bold: true } : {})];
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders,
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    children: [new Paragraph({ spacing: { line: 290 }, children: parts })],
  });
}

function table(widths, header, rows) {
  const total = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, widths[i], { bold: true, fill: "E2E8F0" })) }),
      ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, widths[i])) })),
    ],
  });
}

function box(title, lines, fill = "FEF3C7") {
  return new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [W],
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: W, type: WidthType.DXA },
            borders,
            shading: { fill, type: ShadingType.CLEAR, color: "auto" },
            margins: { top: 110, bottom: 110, left: 160, right: 160 },
            children: [
              new Paragraph({ spacing: { after: 80 }, children: [bold(title)] }),
              ...lines.map((l) => new Paragraph({ spacing: { after: 60, line: 300 }, children: [run(l)] })),
            ],
          }),
        ],
      }),
    ],
  });
}

const why = (lines) => box("왜 이 단계가 필요할까요?", lines, "DBEAFE");
const gap = () => new Paragraph({ spacing: { after: 100 }, children: [] });

const c = [];

c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 80 }, children: [new TextRun({ text: "입고 스캔 업무 매뉴얼", font: FONT, size: 44, bold: true })] }));
c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run("현장 직원용", { size: 26 })] }));
c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [run("초안 1 — 박스 바코드를 찍어 재고에 넣는 일을 처음 하는 분도 따라 할 수 있게 정리했습니다", { size: 20, color: "64748B" })] }));

c.push(H1("1. 이 문서로 하는 일"));
c.push(P("물건(박스)이 들어오면 바코드를 찍고, 저울에 잰 무게를 넣어 재고에 등록하는 방법입니다. 왼쪽 메뉴 \"입고\" → 위쪽 탭 \"입고 스캔\" 화면에서 합니다. 폰과 PC 모두 됩니다."));
c.push(
  box("가장 중요한 원칙 — 꼭 기억하세요", [
    "재고는 박스를 찍고 저울에 잰 실중량을 넣는 순간 늘어납니다.",
    "화면 맨 위 파란 카드가 다음에 할 일을 알려 줍니다. 모르겠으면 카드의 큰 버튼만 따라 하세요.",
    "전표(공급처가 보낸 서류)가 미리 올라와 있지 않아도 됩니다. 그냥 찍으면 재고에 들어갑니다.",
  ])
);
c.push(gap());
c.push(
  why([
    "고기는 법으로 \"어느 농장에서 온 어떤 고기인지\" 번호(이력번호)를 남겨야 합니다. 그래서 박스마다 바코드를 찍어 번호를 기록합니다.",
    "재고와 매입금액은 서류에 적힌 무게가 아니라 저울에 실제로 잰 무게(실중량)로 계산합니다. 서류와 실제 무게가 다를 때가 있어서 돈이 틀어지는 것을 막기 위해서입니다.",
  ])
);
c.push(gap());

c.push(H1("2. 화면 보는 법"));
c.push(P("위에서 아래로 이렇게 되어 있습니다."));
c.push(
  table([2600, 7038], ["자리", "무엇인가요"], [
    ["맨 위 파란 카드", "지금 할 일 하나를 큰 버튼으로 알려 줍니다. 위에 주황색 \"현장 업무\" 표시가 붙으면 현장이 할 일입니다."],
    ["스캔 칸", "박스를 등록하는 곳입니다. 아래 표의 칸이 있습니다."],
    ["결과 카드", "박스를 등록한 직후 색 있는 카드로 결과를 알려 줍니다. (4장)"],
    ["입고 내역", "오늘 찍은 박스 목록입니다(최근 100건). 확인이 필요한 박스는 오래돼도 함께 나옵니다. 잘못 찍은 박스 취소, 상품 지정, 번호 바꾸기는 여기서 합니다."],
  ])
);
c.push(gap());
c.push(P("스캔 칸의 항목입니다."));
c.push(
  table([2500, 4300, 2838], ["칸 이름", "넣는 것", "꼭 필요한가요"], [
    ["이력번호 (바코드)", "스캐너로 박스 바코드를 찍으면 채워집니다. 직접 입력해도 됩니다. 처음 열면 이 칸에 커서가 있습니다.", "꼭 필요"],
    ["표기중량 (kg)", "박스 라벨에 적힌 무게. 바코드에 무게가 들어 있으면 저절로 채워집니다.", "없어도 됨"],
    ["실중량 (kg)", "저울에 올려 잰 진짜 무게. 재고와 매입금액은 이 값으로 계산됩니다.", "꼭 필요"],
    ["매입단가, 매입처", "사장·매니저 계정에만 보입니다. 비우면 상품에 정해 둔 기본값이 들어갑니다.", "직원은 신경 쓰지 않아도 됨"],
  ])
);
c.push(P("카메라 버튼은 스캐너가 없을 때 폰 카메라로 바코드를 읽는 버튼입니다.", { spacing: { before: 100, after: 100 } }));

c.push(H1("3. 박스 하나 찍는 순서"));
c.push(N("이력번호 칸(파란 테두리)에 커서가 있는지 봅니다.", "n1"));
c.push(N("박스 바코드를 스캐너로 찍습니다. 스캐너가 없으면 \"카메라\"를 켜서 비추거나, 라벨의 12자리 번호를 직접 입력하고 Enter를 누릅니다.", "n1"));
c.push(N("\"이력번호 인식 완료\"라는 안내가 뜨면 박스를 저울에 올리고 잰 무게를 \"실중량\" 칸에 넣습니다. 바코드에 무게가 들어 있어 이미 채워져 있으면, 저울 값과 같은지 보고 같으면 그대로, 다르면 저울 값으로 고칩니다.", "n1"));
c.push(N("Enter를 누르거나 \"입고 등록\"을 누릅니다. 몇 초 안에 색 카드가 나옵니다.", "n1"));
c.push(N("초록이면 끝입니다. 다음 박스를 찍습니다. 노랑·빨강이면 4장을 보세요.", "n1"));
c.push(P("저울에 먼저 올려 실중량을 먼저 넣어 두고 바코드를 찍어도 됩니다. 이때는 바코드를 찍는 순간 바로 등록됩니다.", { spacing: { before: 100, after: 100 } }));
c.push(
  why([
    "바코드에 무게가 있어도 바로 등록하지 않고 실중량 칸에 미리 채워 두기만 하는 이유는, 바코드의 무게는 공급처가 적은 값이라 실제와 다를 수 있기 때문입니다. 저울 값이 같으면 Enter 한 번이면 끝납니다.",
    "실중량 칸을 비우고 Enter를 누르면 \"저울에 찍힌 실중량을 입력하세요\"라는 빨간 카드가 나오고 아무것도 등록되지 않습니다. 이력번호 칸이 비어도 같습니다.",
  ])
);
c.push(gap());

c.push(H1("4. 결과 색 카드"));
c.push(P("등록하면 색으로 결과를 알려 줍니다. 초록은 끝, 노랑은 입고는 됐지만 확인이 필요, 빨강은 사람이 처리해야 재고가 잡힘입니다. 한 박스에 사정이 여럿이면 가장 급한 것이 제목이 됩니다."));
c.push(
  table([1100, 3900, 4638], ["색", "카드 제목", "할 일"], [
    ["초록", "입고 완료 — 재고에 반영됐습니다", "끝입니다. 다음 박스를 찍으세요."],
    ["초록", "전표를 저절로 마감했습니다", "이 박스로 전표의 물건이 다 도착했습니다. 사무실이 따로 마감할 필요가 없습니다."],
    ["초록", "전표 없이 입고했습니다", "전표가 아직 안 올라온 상태입니다. 나중에 전표가 올라오면 이 박스가 저절로 이어집니다. 그대로 두세요."],
    ["노랑", "전표에 없는 번호입니다", "입고는 됐습니다. 전표의 어느 줄과도 안 이어졌으니 사무실이 확인합니다. 그대로 두세요."],
    ["노랑", "표기중량과 실중량 차이가 큽니다", "입고는 실중량으로 기록됐습니다. 매입처에 확인하세요."],
    ["노랑", "유통기한이 N일 지난 박스입니다 / N일 남았습니다", "지난 박스는 입고만 기록되고 출고되지 않습니다. 임박한 박스는 먼저 내보내세요."],
    ["노랑", "바코드 상품과 전표 상품이 다릅니다", "바코드 기준으로 입고했습니다. 어느 쪽이 맞는지 사무실에 알려 주세요."],
    ["노랑", "'OO' 상품을 새로 만들어 입고했습니다", "처음 취급하는 고기라 상품이 자동으로 만들어졌습니다. 사무실(상품 관리)에서 판매가를 넣어야 손님에게 보입니다. 알려 주세요."],
    ["노랑", "이미 마감된 전표에 있는 번호입니다", "입고는 됐지만 마감된 전표에는 이어지지 않았습니다. 사무실에 알려 주세요. 사무실이 전표를 다시 열어 이어 줍니다."],
    ["빨강", "이 번호는 이력에서 확인되지 않았습니다", "번호가 틀렸으면 그 박스 옆 \"번호 바꾸기\"로 바로잡습니다(무게는 그대로). 번호가 맞으면 그대로 두어도 시스템이 자동으로 다시 조회합니다. 급하면 상품을 직접 지정하세요. (5장)"],
    ["빨강", "이력 조회 중 오류가 있었습니다", "일시적일 수 있어 시스템이 몇 분 뒤 자동으로 다시 조회합니다. 급하면 박스 옆 \"다시 조회\"를 누르세요."],
    ["빨강", "이력 조회 기능이 설정되지 않아 확인하지 못했습니다", "인증키가 아직 등록되지 않았습니다. 다시 찍어도 소용없습니다. 입고는 기록됐으니 급하면 상품을 직접 지정하세요."],
    ["빨강", "상품을 한 번만 지정해 주세요", "상품을 자동으로 못 정했습니다. 그 박스에서 상품을 지정하면 그때 재고가 늘어납니다. (5장)"],
    ["빨강", "이력번호를 입력하세요 / 저울에 찍힌 실중량을 입력하세요", "비어 있는 파란 테두리 칸을 채우세요."],
    ["빨강", "입고를 등록하지 못했습니다", "카드에 적힌 이유를 읽어 보세요. \"중량이 너무 큽니다\"는 단위(kg)나 소수점을 잘못 넣은 것입니다."],
  ])
);
c.push(gap());

c.push(H1("5. 이런 때는 이렇게"));
c.push(
  table([3700, 5938], ["상황", "방법"], [
    ["\"같은 번호·같은 중량을 찍었습니다. 다른 박스가 맞습니까?\" 창이 뜸", "정말 다른 박스(같은 무게의 박스가 여럿 온 경우)면 \"확인\"을 누르세요. 같은 박스를 두 번 찍은 것이면 \"취소\"를 누르세요. 같은 박스를 실수로 두 번 동시에 보내도 하나만 등록됩니다."],
    ["\"이 값에서 이력번호 형식을 찾지 못했습니다\"", "마트 판매용 바코드 등 이력번호가 아닌 바코드를 찍은 것입니다. 박스 라벨의 이력번호(12자리) 바코드를 찍거나 번호를 직접 입력하세요."],
    ["이력 못 찾음(빨강) — 번호가 틀렸다", "입고 내역의 그 박스 옆 \"번호 바꾸기\" → 맞는 번호를 넣고 \"확인\". 취소하고 다시 찍을 필요가 없습니다. 실중량은 그대로 옮겨집니다. 조회가 되면 바로 재고에 들어갑니다."],
    ["이력 못 찾음(빨강) — 번호는 맞다", "공급처가 아직 등록하지 않았을 수 있습니다. 시스템이 화면이 열려 있는 동안 몇 분마다 자동으로 다시 조회합니다. 급하면 박스 옆 \"다시 조회\"를 누르거나 상품을 직접 지정하세요."],
    ["상품을 한 번만 지정해 주세요(빨강)", "입고 내역의 그 박스에서 상품을 고릅니다. 고르는 순간 재고에 들어갑니다. 이력의 부위와 고른 상품의 부위가 다르면 \"맞는지 확인해주세요\"라는 경고가 나옵니다. 잘못 골랐으면 사무실에 알려 주세요."],
    ["소·돼지가 섞인 공급처 박스, 박스 코드밖에 없음", "이력 못 찾음 카드 아래에 \"박스 나눠서 입고\" 제안이 뜹니다. \"박스 나눠서 입고 (상품 여러 개)\"를 눌러 박스 코드를 한 번 넣고, 상품과 무게를 2줄 이상 넣습니다. 줄마다 이력번호가 따로 있으면 그 줄에 적습니다. 전부 들어가거나 하나도 안 들어갑니다. 중간에 실패하면 이미 넣은 줄도 취소되니 처음부터 다시 넣으세요."],
    ["바코드가 안 읽힘 / 카메라가 안 켜짐", "카메라 권한을 허용했는지 확인하세요. 안 되면 이력번호를 직접 입력하고 Enter를 누릅니다. 브라우저가 바코드 자동 인식을 지원하지 않는 기기도 있습니다."],
    ["보관 위치를 적고 싶음", "입고 내역의 박스 옆에서 나중에 언제든 적을 수 있습니다(선택 사항). 사진도 붙일 수 있습니다."],
  ])
);
c.push(gap());

c.push(H1("6. 전표가 올라와 있을 때"));
c.push(P("사무실이 공급처 전표를 미리 올려 두면, 카드가 \"올 예정인 박스\"를 세어 줍니다. 박스를 찍는 순간 시스템이 전표의 물건과 짝을 맞춥니다. 짝은 확인용이라 재고에는 영향이 없습니다."));
c.push(
  table([3700, 2100, 3838], ["카드에 뜨는 말", "버튼", "무슨 뜻인가요"], [
    ["박스의 바코드를 스캔하세요", "스캔 시작", "처리할 전표가 없습니다. 그냥 찍으면 재고에 들어갑니다."],
    ["박스 N개를 더 찍어 주세요", "박스 스캔하기", "전표에는 있는데 아직 안 찍은 박스가 남았습니다. 오는 대로 찍으세요."],
    ["스캔 종료를 알렸습니다", "스캔 화면으로", "안 온 박스는 사무실이 확인합니다. 박스가 더 오면 그냥 찍으면 됩니다. 저절로 다시 시작됩니다."],
    ["전표의 박스를 모두 찍었습니다", "상품 지정하러 가기 / 박스 더 스캔하기", "다 찍었습니다. 상품 확인이 필요한 박스가 있으면 상품을 지정하세요. 나머지는 사무실이 마감합니다."],
  ])
);
c.push(gap());
c.push(H3("공급처가 물건을 덜 보내 박스가 끝내 안 올 때 — 스캔 종료"));
c.push(P("전표의 박스가 끝내 다 안 오면 화면 위쪽의 \"스캔 종료 (남은 박스 N개는 안 옴)\"를 누릅니다. 확인 창에서 \"종료\"하면 사무실 카드가 \"확인·마감하기\"로 바뀌어 사무실이 안 온 물건과 이유를 적고 마감합니다. 다 왔으면 이 버튼은 나오지 않습니다."));
c.push(B("이 버튼은 표시일 뿐이라 재고는 바뀌지 않습니다."));
c.push(B("종료 뒤에 그 전표의 박스가 더 와서 찍으면 저절로 종료가 풀립니다. \"스캔 다시 시작\" 버튼을 안 눌러도 됩니다."));
c.push(B("전표의 모든 박스가 도착하면 전표는 저절로 마감됩니다. 사무실이 손댈 일이 없습니다."));
c.push(
  why([
    "박스가 안 오는 물건은 현장이 아무리 기다려도 \"다 왔다\"가 될 수 없습니다. 현장이 \"여기까지가 전부다\"라고 알려야 사무실이 사유를 적고 마감할 수 있습니다.",
  ])
);
c.push(gap());

c.push(H1("7. 실수했을 때 되돌리기"));
c.push(
  table([3300, 6338], ["실수", "되돌리는 법"], [
    ["박스를 잘못 찍음", "입고 내역에서 그 박스의 \"취소\"를 누릅니다. 재고가 원래대로 돌아갑니다. 이미 일부가 출고된 박스는 취소할 수 없습니다."],
    ["마감된 전표의 박스를 취소함", "그 줄이 \"안 온 것\"이 되므로 전표가 저절로 다시 열립니다. 화면에 안내가 나옵니다. 같은 박스를 다시 찍으면 그 줄에 다시 이어지고 저절로 마감됩니다. 진짜 안 온 것이면 사무실이 사유를 적고 마감합니다."],
    ["이력번호를 잘못 찍음(아직 \"이력 못 찾음\"이거나 상품 확인 필요)", "박스 옆 \"번호 바꾸기\"로 맞는 번호를 넣습니다."],
    ["이력번호를 잘못 찍었는데 이미 재고에 들어감", "번호는 바꿀 수 없습니다. 그 박스를 취소하고 맞는 번호로 다시 찍으세요."],
    ["상품을 잘못 지정함", "사무실에 알려 주세요. 상품이 잘못 지정된 박스는 취소하고 다시 찍는 것이 가장 확실합니다."],
    ["무게를 잘못 넣음", "그 박스를 취소하고 실중량을 맞게 넣어 다시 찍으세요."],
  ])
);
c.push(P("취소해도 기록은 \"취소됨\"으로 남습니다. 고기 거래 기록은 법으로 남겨야 해서 지우지 않고 취소로 처리합니다.", { spacing: { before: 100, after: 100 } }));

c.push(H1("8. 용어 풀이"));
c.push(
  table([2600, 7038], ["용어", "뜻"], [
    ["이력번호", "소·돼지 등 고기 한 마리마다 붙는 12자리 번호. 박스 바코드에 들어 있고 정부 이력조회로 확인합니다."],
    ["묶음번호(로트)", "여러 마리를 한 묶음으로 묶은 번호."],
    ["실중량 / 표기중량", "저울에 실제로 잰 무게 / 박스 라벨에 적힌 무게."],
    ["전표", "공급처가 보내는 서류. 어떤 물건이 얼마나 오는지 적혀 있습니다."],
    ["스캔 종료", "\"더는 박스가 안 온다\"고 사무실에 알리는 표시."],
    ["상품 지정", "박스가 어떤 상품인지 정하는 것. 이때 재고가 늘어납니다."],
    ["확인 필요", "이력 못 찾음 또는 상품 미확정. 재고에 아직 안 들어간 박스입니다."],
  ])
);

c.push(H1("9. 이 초안에서 확인이 필요한 부분"));
c.push(B("화면 캡처를 넣지 못했습니다. 이 초안은 화면 문구를 코드에서 읽어 적었고, 실제 계정으로 화면을 눌러 본 확인은 아직 안 됐습니다."));
c.push(B("폰과 PC에서 카메라·스캐너 동작은 기기마다 다를 수 있어 실기기 확인이 필요합니다."));
c.push(B("직원 계정에는 매입단가·매입처 칸과 매입금액이 보이지 않는 것으로 적었습니다. 실제 계정으로 확인이 필요합니다."));
c.push(B("사무실 업무(전표 올리기, 도착 확인, 마감)는 별도 문서(사무실용)에 있습니다."));

const doc = new Document({
  creator: "Claude",
  title: "입고 스캔 업무 매뉴얼 (현장용, 초안)",
  styles: { default: { document: { run: { font: FONT, size: 22 } } } },
  numbering: {
    config: [
      { reference: "bul", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
      { reference: "n1", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] },
    ],
  },
  sections: [
    {
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: "입고 스캔 업무 매뉴얼 (현장용, 초안)  ·  ", font: FONT, size: 18, color: "64748B" }),
                new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: "64748B" }),
              ],
            }),
          ],
        }),
      },
      children: c,
    },
  ],
});

Packer.toBuffer(doc).then((b) => {
  fs.writeFileSync(process.argv[2], b);
  console.log("ok");
});
