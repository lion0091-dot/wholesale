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
  warningOptions: Omit<MissingFieldsPageOptions, "missingFields">
): Promise<NextResponse> {
  const missingFields = findMissingStatementFields(data);

  if (missingFields.length > 0) {
    return new NextResponse(renderMissingFieldsHtml({ missingFields, ...warningOptions }), {
      status: 422,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const pdfBuffer = await renderTransactionStatementPdf(data);

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="statement_${data.orderNumber}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
