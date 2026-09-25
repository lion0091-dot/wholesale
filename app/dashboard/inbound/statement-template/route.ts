import { NextResponse } from "next/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { buildStatementTemplate } from "@/lib/livestock/statement-template";

export const runtime = "nodejs";

/** 공급처 명세서 입력 양식(.xlsx) 내려받기 — 로그인한 공급사 계정만. */
export async function GET() {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    return NextResponse.json({ error: "공급사 계정으로 로그인해야 받을 수 있습니다." }, { status: 401 });
  }

  const file = await buildStatementTemplate();
  // 한글 파일명은 헤더에 그대로 못 쓴다 — ASCII 대체 이름과 RFC 5987 인코딩 이름을 함께 준다.
  const koreanName = encodeURIComponent("공급처명세서_입력양식.xlsx");

  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="statement-template.xlsx"; filename*=UTF-8''${koreanName}`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
