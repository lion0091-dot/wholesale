/**
 * 계산서 작성 도우미 라우트가 쓰는 응답 생성 로직.
 * 거래명세서(lib/pdf/statement-response.ts)와 같은 가드(주소 미등록 시 422)를 쓰되,
 * 문서 라벨과 PDF 렌더러만 다르다.
 */

import { NextResponse } from "next/server";
import { findMissingStatementFields, type StatementData } from "@/lib/orders/statement";
import { renderTaxInvoicePdf, type TaxInvoiceOverrides } from "@/lib/pdf/tax-invoice";
import { renderMissingFieldsHtml, type MissingFieldsPageOptions } from "@/lib/pdf/statement-warning-page";

export async function buildTaxInvoiceResponse(
  data: StatementData,
  overrides: TaxInvoiceOverrides,
  warningOptions: Omit<MissingFieldsPageOptions, "missingFields" | "documentLabel">
): Promise<NextResponse> {
  const missingFields = findMissingStatementFields(data);

  if (missingFields.length > 0) {
    return new NextResponse(
      renderMissingFieldsHtml({ missingFields, documentLabel: "계산서", ...warningOptions }),
      {
        status: 422,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const pdfBuffer = await renderTaxInvoicePdf(data, overrides);

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="tax_invoice_${data.orderNumber}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
