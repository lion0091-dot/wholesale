/**
 * 팝빌 공식 Node.js SDK(`popbill`)는 타입 정의가 없는 레거시 콜백 스타일 패키지라
 * 우리가 실제로 쓰는 표면만 최소한으로 선언한다. 나머지 메서드는 SDK 소스
 * (node_modules/popbill/lib/TaxinvoiceService.js)를 직접 참고할 것.
 */
declare module "popbill" {
  export interface PopbillConfig {
    LinkID: string;
    SecretKey: string;
    IsTest?: boolean;
    defaultErrorHandler?: (error: PopbillError) => void;
  }

  export interface PopbillError {
    code: number;
    message: string;
  }

  export function config(cfg: PopbillConfig): void;

  export interface TaxinvoiceDetail {
    serialNum?: number;
    itemName: string;
    purchaseDT?: string;
    qty?: string;
    unitCost?: string;
    spec?: string;
    supplyCost: string;
    tax?: string;
    remark?: string;
  }

  export interface TaxinvoiceForm {
    writeDate: string;
    chargeDirection: "정과금" | "역과금";
    issueType: "정발행" | "역발행" | "위수탁발행";
    purposeType: "영수" | "청구";
    issueTiming: "직접발행" | "예약발행";
    taxType: "과세" | "면세" | "영세";

    invoicerCorpNum: string;
    invoicerMgtKey: string;
    invoicerTaxRegID?: string;
    invoicerCorpName: string;
    invoicerCEOName: string;
    invoicerAddr: string;
    invoicerBizClass?: string;
    invoicerBizType?: string;
    invoicerContactName: string;
    invoicerTEL?: string;
    invoicerHP?: string;
    invoicerEmail?: string;
    invoicerSMSSendYN?: boolean;

    invoiceeType: "사업자" | "개인" | "외국";
    invoiceeCorpNum: string;
    invoiceeMgtKey?: string;
    invoiceeTaxRegID?: string;
    invoiceeCorpName: string;
    invoiceeCEOName?: string;
    invoiceeAddr?: string;
    invoiceeBizClass?: string;
    invoiceeBizType?: string;
    invoiceeContactName1?: string;
    invoiceeTEL1?: string;
    invoiceeHP1?: string;
    invoiceeEmail1?: string;
    invoiceeSMSSendYN?: boolean;

    taxTotal: string;
    supplyCostTotal: string;
    totalAmount: string;

    /** 국세청 표준 수정사유 코드(1~6). 정정(수정계산서) 발행일 때만 채운다. */
    modifyCode?: 1 | 2 | 3 | 4 | 5 | 6;
    /** 정정 대상 원본 문서의 팝빌 문서키(발행 성공 응답의 invoicerMgtKey 기준 재조회값). */
    originalTaxinvoiceKey?: string;

    remark1?: string;
    remark2?: string;
    remark3?: string;

    detailList?: TaxinvoiceDetail[];
  }

  export interface JoinMemberForm {
    LinkID: string;
    CorpNum: string;
    CEOName: string;
    CorpName: string;
    Addr: string;
    BizType?: string;
    BizClass?: string;
    ContactName: string;
    ContactEmail?: string;
    ContactTEL?: string;
    ID: string;
    PWD: string;
  }

  export interface CheckIsMemberResponse {
    code: number;
    message: string;
    /** 이미 회원이면 1, 아니면 -1 (팝빌 응답 관례 — 실계정으로 재확인 필요). */
    itemCode: number;
    /** 회원이면 true. SDK 응답 필드명은 실계정 검증 전까지 추정치. */
    isMember?: boolean;
  }

  export interface JoinMemberResponse {
    code: number;
    message: string;
  }

  export interface RegistIssueResponse {
    code: number;
    message: string;
    ntsconfirmNum?: string;
    mgtKey?: string;
  }

  export interface GetInfoResponse {
    invoicerMgtKey: string;
    ntsconfirmNum?: string;
    stateCode: string;
    [key: string]: unknown;
  }

  export interface TaxinvoiceService {
    checkIsMember(
      corpNum: string,
      success: (response: CheckIsMemberResponse) => void,
      error: (error: PopbillError) => void
    ): void;

    joinMember(
      form: JoinMemberForm,
      success: (response: JoinMemberResponse) => void,
      error: (error: PopbillError) => void
    ): void;

    registIssue(
      corpNum: string,
      taxinvoice: TaxinvoiceForm,
      writeSpecification: boolean,
      forceIssue: boolean,
      memo: string,
      emailSubject: string,
      dealInvoiceMgtKey: string,
      userId: string,
      success: (response: RegistIssueResponse) => void,
      error: (error: PopbillError) => void
    ): void;

    getInfo(
      corpNum: string,
      mgtKeyType: string,
      mgtKey: string,
      success: (response: GetInfoResponse) => void,
      error: (error: PopbillError) => void
    ): void;

    cancelIssue(
      corpNum: string,
      mgtKeyType: string,
      mgtKey: string,
      memo: string,
      success: (response: { code: number; message: string }) => void,
      error: (error: PopbillError) => void
    ): void;
  }

  export function TaxinvoiceService(): TaxinvoiceService;

  export const MgtKeyType: {
    SELL: string;
    BUY: string;
    TRUSTEE: string;
  };
}
