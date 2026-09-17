/**
 * 거래명세서 PDF 라우트(공급사용/바이어용)가 공유하는 응답 생성 로직.
 * 필수 정보가 비어 있으면 422 안내 페이지, 다 채워져 있으면 PDF 응답을 돌려준다.
 */

import { NextResponse } from "next/server";
import { findMissingStatementFields, type StatementData } from "@/lib/orders/statement";
import { renderTransactionStatementPdf } from "@/lib/pdf/transaction-statement";
import { renderMissingFieldsHtml, type MissingFieldsPageOptions } from "@/lib/pdf/statement-warning-page";

export async function buildStatementResponse(
  data: StatementData,
  warningOptions: Omit<MissingFieldsPageOptions, "missingFields">,
  /** true면 브라우저가 뷰어로 열지 않고 바로 파일로 저장하도록 유도한다 (카카오 인앱 브라우저 등 자체 PDF 뷰어가 없는 환경 대응). */
  download = false
): Promise<NextResponse> {
  const missingFields = findMissingStatementFields(data);

  if (missingFields.length > 0) {
    return new NextResponse(renderMissingFieldsHtml({ missingFields, ...warningOptions }), {
      status: 422,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const pdfBuffer = await renderTransactionStatementPdf(data);
  const disposition = download ? "attachment" : "inline";

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="statement_${data.orderNumber}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
