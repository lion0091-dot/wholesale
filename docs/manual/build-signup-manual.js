// 가입·로그인 매뉴얼(공급사·고객용) 빌더 — 사용: node build-signup-manual.js <출력.docx>
// 화면 캡처는 로컬 테스트 계정으로 찍은 것이라 상호·이름·번호는 예시다(docs/manual/signup-shots).
const h = require("./docx-helpers.js");
const { fs, path, Document, Packer, Paragraph, TextRun, AlignmentType, LevelFormat, Footer, PageNumber, FONT, run, P, B, N, H1, H2, H3, bold, table, box, why, gap, figure } = h;

const shot = (name) => path.join(__dirname, "signup-shots", name);
const c = [];

c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 80 }, children: [new TextRun({ text: "가입·로그인 이용 매뉴얼", font: FONT, size: 40, bold: true })] }));
c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run("공급사(도매업체) · 고객(식당·소매) 공통", { size: 26 })] }));
c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [run("초안 1 — 화면 캡처는 테스트 데이터입니다(상호·이름·번호는 예시)", { size: 20, color: "64748B" })] }));

c.push(H1("1. 먼저 알아둘 것"));
c.push(B("가입과 로그인은 모두 카카오 계정으로 합니다. 따로 아이디·비밀번호를 만들지 않습니다."));
c.push(B("공급사(도매업체)는 스스로 가입합니다. 고객(식당·소매)은 공급사가 보내 준 전용 초대 링크로만 들어옵니다."));
c.push(B("공급사는 가입 직후 바로 상품 등록과 주문 접수를 시작할 수 있습니다. 승인 심사는 따로 진행되고, 승인이 끝나야 고객 초대장 발부가 열립니다."));
c.push(gap());
c.push(
  table(
    [2200, 3700, 3738],
    ["", "공급사(도매업체)", "고객(식당·소매)"],
    [
      ["들어오는 방법", "로그인 화면에서 직접 가입", "공급사가 보낸 초대 링크"],
      ["가입 후 바로 되는 것", "상품 등록, 맞춤 단가, 주문 접수, 마이페이지", "초대받은 공급사의 미니샵에서 주문"],
      ["심사", "사업자등록 진위확인 후 승인(승인 후 초대장 발부 가능)", "없음(공급사가 초대한 전화번호와 맞아야 연결)"],
    ]
  )
);

c.push(H1("2. 공급사 가입하기"));
c.push(H2("2-1. 로그인 화면에서 시작"));
c.push(P("공급사 로그인 화면을 열고 노란색 [카카오로 3초 시작하기]를 누릅니다. 처음 접속하는 카카오 계정이면 그대로 가입이 진행됩니다."));
c.push(...figure(shot("01-login.png"), "그림 1 — 공급사 로그인 화면. 카카오 버튼 하나로 시작합니다.", 560));
c.push(P("카카오 로그인·동의 창이 뜨면 안내에 따라 진행합니다(이 창은 카카오가 보여 주는 화면이라 이 문서에는 싣지 않았습니다)."));

c.push(H2("2-2. 가입 마무리 — 약관 동의와 기본 정보"));
c.push(P("카카오 로그인이 끝나면 \"가입 마무리\" 화면이 나옵니다. 아래 항목만 채우면 승인을 기다리지 않고 바로 시작할 수 있습니다."));
c.push(...figure(shot("02-onboarding-empty.png"), "그림 2 — 가입 마무리 화면(처음 모습)", 420));
c.push(
  table(
    [2600, 7038],
    ["항목", "입력 방법"],
    [
      ["상호(업체명) *", "고객(식당)에게 보이는 이름입니다. 나중에 수정할 수 있습니다."],
      ["담당자(대표자) 성명 *", "카카오 이름이 미리 들어옵니다. 사업자등록증의 대표자명과 같게 고치는 것을 권장합니다."],
      ["연락처 *", "주문 접수 알림과 승인 결과 안내를 받을 번호입니다."],
      ["사업장 주소 *", "거래명세서 PDF의 공급자란에 표시됩니다. 나중에 수정할 수 있습니다."],
      ["사업자등록번호 (선택)", "지금 입력하면 승인 심사가 바로 시작됩니다. 나중에 [설정]에서 등록해도 됩니다."],
      ["약관 동의", "[필수] 서비스 이용약관, [필수] 개인정보 수집·이용, [선택] 마케팅·알림톡 수신. [전체 동의]를 누르면 모두 체크됩니다."],
    ]
  )
);
c.push(gap());
c.push(...figure(shot("03-onboarding-filled.png"), "그림 3 — 입력을 마친 모습. [동의하고 바로 시작하기]를 누릅니다.", 420));
c.push(box("약관은 꼭 읽어 보세요", ["수집 항목, 이용 목적, 보유·이용기간, 동의 거부 권리가 화면 아래에 적혀 있습니다. [필수] 항목에 동의하지 않으면 가입할 수 없고, [선택] 항목은 거부해도 이용에 불이익이 없습니다."], "FEF3C7"));

c.push(H2("2-3. 첫 화면 — 알림 켜기"));
c.push(P("가입이 끝나면 대시보드가 열리고, 처음에는 \"새 주문 알림을 켜세요\" 창이 한 번 뜹니다. [알림 켜기]를 누르고 브라우저가 묻는 \"알림 허용\"을 승인하세요."));
c.push(...figure(shot("04-alert-prompt.png"), "그림 4 — 처음 한 번 뜨는 알림 안내 창", 560));
c.push(B("알림을 켜 두면 화면이 꺼져 있어도 새 주문·취소 요청이 폰·PC로 옵니다. 안 켜면 주문을 늦게 알 수 있습니다."));
c.push(B("[나중에]를 눌러도 화면 맨 위에 빨간 줄이 계속 남아 알려 줍니다. 켜면 사라집니다."));
c.push(B("아이폰은 사파리 공유 버튼 → \"홈 화면에 추가\"로 앱을 설치한 뒤, 그 앱에서 알림을 켜야 합니다."));
c.push(B("알림이 차단돼 있다고 나오면 주소창 옆 자물쇠(설정)에서 알림을 \"허용\"으로 바꾸고 새로고침하세요."));
c.push(B("화면을 켜 둔 동안에는 새 주문이 오면 소리와 알림 창이 뜹니다. 소리는 종 모양 버튼의 [새 주문 소리]에서 끌 수 있습니다."));
c.push(...figure(shot("05-dashboard-pending.png"), "그림 5 — 가입 직후 대시보드. \"승인 심사 진행 중\" 안내가 보입니다.", 560));

c.push(H1("3. 승인 받기 (사업자 정보 제출)"));
c.push(P("승인은 사업자등록 정보를 운영팀이 국세청 자료와 대조해서 확인하는 절차입니다. 승인 전에도 상품 등록·단가·주문 접수는 쓸 수 있지만, 고객 초대장 발부는 승인 후에 열립니다."));
c.push(H2("3-1. 정보 입력"));
c.push(N("대시보드의 \"승인 상태 및 사업자 정보 확인 →\"을 누르거나 왼쪽 메뉴 [설정] → [초대장 · 업체 설정]으로 갑니다.", "num"));
c.push(N("\"사업자 정보 제출\"에서 대표자(담당자) 성명을 확인합니다. 국세청 대조에 쓰이니 사업자등록증의 대표자명과 한 글자도 다르지 않게 적으세요(공동대표는 \"외 1명\" 없이 대표자 1인 성명만).", "num"));
c.push(N("사업자등록번호(숫자 10자리)와 개업일자를 넣고 [심사 요청]을 누릅니다. 개업일자는 사업자등록증에 적혀 있습니다.", "num"));
c.push(N("사업자등록증 사본(JPG·PNG·PDF, 8MB 이하)이 있으면 [업로드]로 올립니다. 운영팀 대조에 쓰입니다.", "num"));
c.push(...figure(shot("06-business-number-input.png"), "그림 6 — 사업자등록번호와 개업일자 입력", 560));
c.push(...figure(shot("07-business-number-result.png"), "그림 7 — 제출 완료. 승인되면 \"행정 승인\" 상태가 바뀝니다(캡처는 이전 문구)", 560));
c.push(H2("3-2. 승인 결과"));
c.push(B("승인이 되면 대시보드의 \"승인 심사 진행 중\" 안내가 사라지고 고객 초대장 발부가 열립니다."));
c.push(B("승인 결과는 [설정]의 \"승인 상태\" 표(행정 승인)와 대시보드 안내로 확인합니다. 알림톡 안내는 카카오 채널 개설 후에 제공될 예정입니다."));
c.push(B("사업자번호나 대표자명이 국세청 자료와 안 맞으면 승인이 보류됩니다. 입력을 고쳐 다시 [심사 요청]을 누르거나 운영팀에 문의하세요."));
c.push(box("번호가 틀렸다고 나올 때", ["번호 형식(체크섬)이 맞아도 국세청에 실제로 등록된 사업자가 아니면 \"진위확인 불일치\"가 됩니다. 사업자등록증을 보고 번호·대표자명·개업일자를 다시 확인하세요."], "DBEAFE"));

c.push(H1("4. 고객(식당·소매) 가입하기"));
c.push(P("고객은 공급사가 보내 준 초대 링크(미니샵 주소)로 들어옵니다. 링크는 공급사 대시보드의 [미니샵 초대 링크]에서 복사해 카카오톡 등으로 전달합니다."));
c.push(H2("4-1. 카카오 로그인"));
c.push(...figure(shot("08-shop-login-gate.png"), "그림 8 — 초대 링크를 열면 나오는 화면", 520));
c.push(P("[카카오로 3초 시작하기]를 누르고 카카오 로그인을 마칩니다. 링크가 다른 사람에게 전달돼도 본인 카카오 계정이 없으면 주문 내역을 볼 수 없습니다."));
c.push(H2("4-2. 약관 동의"));
c.push(P("처음 한 번 \"거의 다 됐어요\" 화면에서 동의합니다. [전체 동의]를 누르고 [동의하고 시작하기]를 누르세요."));
c.push(...figure(shot("09-buyer-consent.png"), "그림 9 — 동의 화면(처음 모습)", 480));
c.push(...figure(shot("10-buyer-consent-checked.png"), "그림 10 — 모두 동의한 모습", 480));
c.push(B("[필수] 서비스 이용약관, [필수] 개인정보 수집·이용(상호·연락처·배송지)에 동의해야 시작할 수 있습니다. [선택] 특가·신상품 알림톡은 거부해도 됩니다."));
c.push(H2("4-3. 주문 시작"));
c.push(P("동의가 끝나면 공급사의 미니샵이 열립니다. 상품을 담아 주문하고, [내 주문 내역]에서 확인합니다."));
c.push(...figure(shot("11-shop-home.png"), "그림 11 — 미니샵 첫 화면(예시 상품)", 480));
c.push(box("초대받지 않은 계정은 열리지 않습니다", ["공급사가 초대한 전화번호와 연결된 계정만 거래처로 등록되어 상품과 단가를 볼 수 있습니다. 링크만 갖고 들어온 다른 사람에게는 미니샵이 열리지 않을 수 있습니다. 열리지 않으면 공급사에 초대를 요청하세요."], "FEF3C7"));

c.push(H1("5. 로그인과 로그아웃"));
c.push(B("로그인: 공급사는 로그인 화면(그림 1), 고객은 받은 초대 링크에서 [카카오로 3초 시작하기]를 누릅니다. 이미 가입했다면 같은 카카오 계정으로 로그인하면 됩니다."));
c.push(B("로그아웃: 화면 오른쪽 위 [로그아웃]을 누릅니다."));
c.push(B("탈퇴: 공급사는 [설정] 맨 아래, 고객은 [내 거래처] 화면에서 할 수 있습니다. 정산이 안 끝난 외상이 있으면 탈퇴가 보류됩니다."));

c.push(H1("6. 확인이 필요한 부분"));
c.push(B("이 문서의 화면은 테스트 환경에서 찍었습니다. 실제 서비스 주소·상호·카카오 화면은 다를 수 있습니다."));
c.push(B("카카오 로그인·동의 창은 카카오가 보여 주는 화면이라 캡처에 넣지 않았습니다."));
c.push(B("승인 결과 알림톡과 일부 알림은 카카오 채널 개설 후에 제공됩니다."));

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 22 } } } },
  numbering: {
    config: [
      { reference: "bul", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
      { reference: "num", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] },
    ],
  },
  sections: [
    {
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "가입·로그인 이용 매뉴얼 (초안)  ·  ", font: FONT, size: 18, color: "64748B" }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: "64748B" })] })] }) },
      children: c,
    },
  ],
});

Packer.toBuffer(doc).then((b) => {
  fs.writeFileSync(process.argv[2], b);
  console.log("ok");
});
