/**
 * 계산서 작성 도우미 라우트가 쓰는 응답 생성 로직.
 * 거래명세서(lib/pdf/statement-response.ts)와 비슷한 가드(422)를 쓰되, 계산서는
 * 공급받는자 사업자등록번호까지 필수라 findMissingTaxInvoiceFields로 하나 더 확인한다.
 */

import { NextResponse } from "next/server";
import { findMissingTaxInvoiceFields, type StatementData } from "@/lib/orders/statement";
import { renderTaxInvoicePdf, type TaxInvoiceOverrides } from "@/lib/pdf/tax-invoice";
import { renderMissingFieldsHtml, type MissingFieldsPageOptions } from "@/lib/pdf/statement-warning-page";

const SUPPLIER_ADDRESS_FIELD = "공급사(도매) 사업장 주소";
const BUYER_BUSINESS_NUMBER_FIELD = "고객(소매) 사업자등록번호";

export async function buildTaxInvoiceResponse(
  data: StatementData,
  overrides: TaxInvoiceOverrides,
  /** actionHref/actionLabel은 "공급사 본인이 고칠 수 있는" 사업장 주소 케이스에만 쓴다 —
   * 고객 사업자등록번호 미등록은 이 함수가 자체적으로 note를 붙여 안내한다(공급사는
   * 그 값을 대신 고칠 수 없으므로 같은 버튼을 보여주면 안 된다). */
  warningOptions: Omit<MissingFieldsPageOptions, "missingFields" | "documentLabel" | "note">
): Promise<NextResponse> {
  const missingFields = findMissingTaxInvoiceFields(data);

  if (missingFields.length > 0) {
    const missingSupplierAddress = missingFields.includes(SUPPLIER_ADDRESS_FIELD);
    const missingBuyerBusinessNumber = missingFields.includes(BUYER_BUSINESS_NUMBER_FIELD);

    return new NextResponse(
      renderMissingFieldsHtml({
        missingFields,
        documentLabel: "계산서",
        // 공급사 본인이 고칠 수 있는 항목이 섞여있을 때만 액션 버튼을 보여준다.
        actionHref: missingSupplierAddress ? warningOptions.actionHref : undefined,
        actionLabel: missingSupplierAddress ? warningOptions.actionLabel : undefined,
        note: missingBuyerBusinessNumber
          ? "고객(소매) 사업자등록번호는 공급사가 아니라 고객 본인이 미니샵의 '내 정보 수정'에서 등록해야 합니다. 고객에게 등록을 요청해주세요."
          : undefined,
      }),
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
