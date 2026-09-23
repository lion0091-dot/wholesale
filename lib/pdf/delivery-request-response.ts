/**
 * 배송의뢰서 PDF 라우트가 공유하는 응답 생성 로직 (statement-response.ts와 동일 패턴).
 * 필수 정보가 비어 있으면 422 안내 페이지, 다 채워져 있으면 PDF 응답을 돌려준다.
 */

import { NextResponse } from "next/server";
import {
  findMissingDeliveryRequestFields,
  type DeliveryRequestData,
} from "@/lib/orders/delivery-request";
import { renderDeliveryRequestPdf } from "@/lib/pdf/delivery-request";
import { renderMissingFieldsHtml, type MissingFieldsPageOptions } from "@/lib/pdf/statement-warning-page";

export async function buildDeliveryRequestResponse(
  data: DeliveryRequestData,
  warningOptions: Omit<MissingFieldsPageOptions, "missingFields" | "documentLabel">,
  download = false
): Promise<NextResponse> {
  const missingFields = findMissingDeliveryRequestFields(data);

  if (missingFields.length > 0) {
    return new NextResponse(
      renderMissingFieldsHtml({ missingFields, documentLabel: "배송의뢰서", ...warningOptions }),
      {
        status: 422,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const pdfBuffer = await renderDeliveryRequestPdf(data);
  const disposition = download ? "attachment" : "inline";

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="delivery_request_${data.orderNumber}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
