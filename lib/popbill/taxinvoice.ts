import crypto from "crypto";
import * as popbillClient from "@/lib/popbill/client";
import type { StatementData } from "@/lib/orders/statement";
import type { createClient } from "@/lib/supabase/server";
import type { TaxinvoiceForm } from "popbill";
import { MODIFY_CODE_LABELS, type ModifyCode } from "@/lib/popbill/modify-codes";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export { MODIFY_CODE_LABELS, type ModifyCode };

/**
 * 계산서 발행(팝빌)에 필요한 필수 사업자정보가 다 있는지 확인한다.
 * 거래명세서(findMissingStatementFields)는 공급자 주소만 보지만, 계산서는 국세청에
 * 실제 접수되는 문서라 공급자/공급받는자 양쪽의 사업자등록번호까지 필수다.
 */
export function findMissingTaxInvoiceFields(data: StatementData): string[] {
  const missing: string[] = [];

  if (!data.supplier.businessNumber) missing.push("공급사(도매) 사업자등록번호");
  if (!data.supplier.address) missing.push("공급사(도매) 사업장 주소");
  if (!data.buyer.businessNumber) missing.push("공급받는자(식당) 사업자등록번호");

  return missing;
}

function toDigitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/**
 * 팝빌 문서관리번호(MgtKey). 회원(공급사)별로 유일해야 하며, 정정 발행 시 원본과는
 * 다른 새 키를 발급받아야 한다(원본 연결은 originalTaxinvoiceKey로 한다).
 */
function generateMgtKey(orderId: string): string {
  return `oi${orderId.replace(/-/g, "").slice(0, 12)}${Date.now().toString(36)}`;
}

/**
 * 팝빌 연동회원 가입 ID. 사업자번호 기반으로 결정적으로 생성해 재가입 시도 시
 * 항상 같은 값이 나오게 한다(멱등성). 팝빌 ID 규칙(영문/숫자, 길이 제한)은 실계정
 * 가입 전까지 미검증 — 문제가 있으면 이 함수만 고치면 된다.
 */
function derivePopbillMemberId(businessNumber: string): string {
  return `wsl${toDigitsOnly(businessNumber)}`;
}

export interface EnsurePopbillMemberResult {
  memberId: string;
  alreadyJoined: boolean;
}

/**
 * 공급사를 팝빌 연동회원으로 자동 가입시킨다. 알림톡과 달리 공급사가 직접 팝빌에
 * 가입할 필요가 없다 — 플랫폼 파트너 계정(LinkID) 밑에 사업자번호로 등록만 하면 된다.
 * 비밀번호는 여기서만 쓰고 저장하지 않는다(가입 이후 API 호출은 파트너 SecretKey +
 * CorpNum 조합으로만 이뤄지고, 팝빌 웹 포털 로그인은 이 플랫폼 흐름에 필요 없다).
 */
export async function ensurePopbillMember(
  supabase: SupabaseServerClient,
  wholesalerId: string
): Promise<EnsurePopbillMemberResult> {
  const { data: wholesaler, error } = await supabase
    .from("wholesalers")
    .select(
      "business_number, business_name, representative_name, business_address, popbill_member_id, popbill_joined_at, profile_id"
    )
    .eq("id", wholesalerId)
    .maybeSingle();

  if (error || !wholesaler) {
    throw new Error("공급사 정보를 찾을 수 없습니다.");
  }

  if (wholesaler.popbill_member_id && wholesaler.popbill_joined_at) {
    return { memberId: wholesaler.popbill_member_id, alreadyJoined: true };
  }

  if (!wholesaler.business_number || !wholesaler.business_address) {
    throw new Error(
      "계산서 발행 연동을 켜려면 사업자등록번호와 사업장 주소가 먼저 등록되어 있어야 합니다."
    );
  }

  const corpNum = toDigitsOnly(wholesaler.business_number);
  const memberId = derivePopbillMemberId(wholesaler.business_number);

  const membership = await popbillClient.checkIsMember(corpNum);

  if (membership.itemCode !== 1) {
    await popbillClient.joinMember({
      LinkID: process.env.POPBILL_LINK_ID ?? "",
      CorpNum: corpNum,
      CEOName: wholesaler.representative_name,
      CorpName: wholesaler.business_name,
      Addr: wholesaler.business_address,
      ContactName: wholesaler.representative_name,
      ID: memberId,
      PWD: crypto.randomBytes(16).toString("base64url"),
    });
  }

  const { error: updateError } = await supabase
    .from("wholesalers")
    .update({ popbill_member_id: memberId, popbill_joined_at: new Date().toISOString() })
    .eq("id", wholesalerId);

  if (updateError) {
    throw new Error("팝빌 연동회원 가입 상태 저장에 실패했습니다.");
  }

  return { memberId, alreadyJoined: false };
}

interface BuildFormOptions {
  mgtKey: string;
  modifyCode?: ModifyCode;
  originalTaxinvoiceKey?: string;
}

/** StatementData(주문 데이터) -> 팝빌 계산서 필드 매핑. 면세 고정(docs/tax-invoice-draft.md 잠긴 결정). */
export function mapToTaxinvoiceForm(data: StatementData, options: BuildFormOptions): TaxinvoiceForm {
  if (!data.supplier.businessNumber || !data.buyer.businessNumber) {
    throw new Error("사업자등록번호가 없어 계산서 양식을 만들 수 없습니다.");
  }

  const writeDate = data.orderedAt.slice(0, 10).replace(/-/g, "");

  return {
    writeDate,
    chargeDirection: "정과금",
    issueType: "정발행",
    purposeType: "영수",
    issueTiming: "직접발행",
    taxType: "면세",

    invoicerCorpNum: toDigitsOnly(data.supplier.businessNumber),
    invoicerMgtKey: options.mgtKey,
    invoicerCorpName: data.supplier.name,
    invoicerCEOName: data.supplier.representativeName ?? "",
    invoicerAddr: data.supplier.address ?? "",
    invoicerContactName: data.supplier.representativeName ?? "",
    invoicerTEL: data.supplier.phone ?? undefined,

    invoiceeType: "사업자",
    invoiceeCorpNum: toDigitsOnly(data.buyer.businessNumber),
    invoiceeCorpName: data.buyer.name,
    invoiceeCEOName: data.buyer.representativeName ?? "",
    invoiceeAddr: data.buyer.address ?? "",
    invoiceeContactName1: data.buyer.representativeName ?? "",
    invoiceeTEL1: data.buyer.phone ?? undefined,

    taxTotal: "0",
    supplyCostTotal: String(data.totalAmount),
    totalAmount: String(data.totalAmount),

    modifyCode: options.modifyCode,
    originalTaxinvoiceKey: options.originalTaxinvoiceKey,

    detailList: data.items.map((item, index) => ({
      serialNum: index + 1,
      itemName: item.productName,
      qty: String(item.quantity),
      unitCost: String(item.unitPrice),
      supplyCost: String(item.subtotalAmount),
      tax: "0",
    })),
  };
}

export interface TaxInvoiceIssuanceRow {
  id: string;
  order_id: string;
  wholesaler_id: string;
  original_issuance_id: string | null;
  popbill_mgt_key: string;
  popbill_nts_confirm_num: string | null;
  status: "pending" | "issued" | "failed" | "cancelled";
  modify_code: ModifyCode | null;
  error_message: string | null;
}

async function recordFailure(
  supabase: SupabaseServerClient,
  rowId: string,
  message: string
): Promise<never> {
  await supabase
    .from("tax_invoice_issuances")
    .update({ status: "failed", error_message: message })
    .eq("id", rowId);
  throw new Error(message);
}

/**
 * 최초 발행. 팝빌 연동회원 자동가입 -> 발행이력 row(pending) 선등록 -> registIssue ->
 * 성공/실패에 따라 row 갱신, 순서로 진행한다. row를 발행 시도 "전"에 pending으로
 * 먼저 만드는 이유는 registIssue가 네트워크 타임아웃 등으로 응답 없이 끊겨도
 * (실제로는 국세청에 접수됐을 가능성) 시도 흔적이 남아야 정정/재확인이 가능하기 때문.
 */
export async function issueTaxInvoice(
  supabase: SupabaseServerClient,
  wholesalerId: string,
  orderId: string,
  statementData: StatementData
): Promise<TaxInvoiceIssuanceRow> {
  const missing = findMissingTaxInvoiceFields(statementData);
  if (missing.length > 0) {
    throw new Error(`다음 정보가 없어 계산서를 발행할 수 없습니다: ${missing.join(", ")}`);
  }

  await ensurePopbillMember(supabase, wholesalerId);
  const mgtKey = generateMgtKey(orderId);

  const { data: row, error: insertError } = await supabase
    .from("tax_invoice_issuances")
    .insert({
      order_id: orderId,
      wholesaler_id: wholesalerId,
      popbill_mgt_key: mgtKey,
      status: "pending",
    })
    .select()
    .single();

  if (insertError || !row) {
    // 주문당 살아 있는(진행 중/발행 완료) 최초 발행이력은 하나뿐이다(20260930000109) — 버튼을
    // 두 번 눌러도 국세청에 이중 접수되지 않는다. 사유를 알려 정정 발행으로 안내한다.
    if (insertError?.message.includes("idx_tax_invoice_issuances_one_live_original")) {
      throw new Error(
        "이 발주는 이미 계산서 발행이 진행 중이거나 발행 완료되었습니다. 내용을 바꿔야 하면 '정정 발행'을 이용해주세요."
      );
    }

    throw new Error("발행 이력 생성에 실패했습니다.");
  }

  const corpNum = toDigitsOnly(statementData.supplier.businessNumber ?? "");
  const form = mapToTaxinvoiceForm(statementData, { mgtKey });

  try {
    const response = await popbillClient.registIssue(corpNum, form, `주문 ${statementData.orderNumber} 계산서 발행`);

    const { data: updated, error: updateError } = await supabase
      .from("tax_invoice_issuances")
      .update({
        status: "issued",
        popbill_nts_confirm_num: response.ntsconfirmNum ?? null,
        issued_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .select()
      .single();

    if (updateError || !updated) {
      throw new Error("발행은 성공했지만 이력 갱신에 실패했습니다 — 팝빌 관리 화면에서 직접 확인해주세요.");
    }

    return updated as TaxInvoiceIssuanceRow;
  } catch (err) {
    return recordFailure(supabase, row.id, err instanceof Error ? err.message : "알 수 없는 오류");
  }
}

/**
 * 정정(수정계산서) 발행. 원본 발행 row를 찾아 원본 문서키를 연결한 새 계산서를
 * 발행한다. originalTaxinvoiceKey에 원본의 popbill_mgt_key를 그대로 넘기는 방식이
 * 맞는지는 팝빌 공식 문서(비공개 SPA라 확인 못함) 기준이 아니라 SDK 예제 코드의
 * 필드명 추정이라 — 실계정 테스트 전까지 미검증. 틀렸다면 이 함수의 originalTaxinvoiceKey
 * 값 채우는 부분만 고치면 된다.
 */
export async function issueTaxInvoiceCorrection(
  supabase: SupabaseServerClient,
  wholesalerId: string,
  originalIssuanceId: string,
  modifyCode: ModifyCode,
  statementData: StatementData
): Promise<TaxInvoiceIssuanceRow> {
  const { data: original, error: originalError } = await supabase
    .from("tax_invoice_issuances")
    .select("id, order_id, wholesaler_id, popbill_mgt_key, status")
    .eq("id", originalIssuanceId)
    .eq("wholesaler_id", wholesalerId)
    .maybeSingle();

  if (originalError || !original) {
    throw new Error("정정할 원본 계산서를 찾을 수 없습니다.");
  }

  if (original.status !== "issued") {
    throw new Error("발행 완료된 계산서만 정정할 수 있습니다.");
  }

  const mgtKey = generateMgtKey(original.order_id);

  const { data: row, error: insertError } = await supabase
    .from("tax_invoice_issuances")
    .insert({
      order_id: original.order_id,
      wholesaler_id: wholesalerId,
      original_issuance_id: original.id,
      popbill_mgt_key: mgtKey,
      modify_code: modifyCode,
      status: "pending",
    })
    .select()
    .single();

  if (insertError || !row) {
    throw new Error("정정 발행 이력 생성에 실패했습니다.");
  }

  const corpNum = toDigitsOnly(statementData.supplier.businessNumber ?? "");
  const form = mapToTaxinvoiceForm(statementData, {
    mgtKey,
    modifyCode,
    originalTaxinvoiceKey: original.popbill_mgt_key,
  });

  try {
    const response = await popbillClient.registIssue(
      corpNum,
      form,
      `주문 ${statementData.orderNumber} 계산서 정정발행 (${MODIFY_CODE_LABELS[modifyCode]})`
    );

    const { data: updated, error: updateError } = await supabase
      .from("tax_invoice_issuances")
      .update({
        status: "issued",
        popbill_nts_confirm_num: response.ntsconfirmNum ?? null,
        issued_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .select()
      .single();

    if (updateError || !updated) {
      throw new Error("정정발행은 성공했지만 이력 갱신에 실패했습니다 — 팝빌 관리 화면에서 직접 확인해주세요.");
    }

    return updated as TaxInvoiceIssuanceRow;
  } catch (err) {
    return recordFailure(supabase, row.id, err instanceof Error ? err.message : "알 수 없는 오류");
  }
}
