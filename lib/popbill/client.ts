import * as popbill from "popbill";

/**
 * 팝빌은 파트너(플랫폼) 하나가 LinkID+SecretKey로 계약하고, 그 밑에 공급사(사업자번호
 * 기준)를 "연동회원"으로 등록해 대신 발행하는 구조다(알림톡처럼 공급사별 계약이 아님).
 * config()는 프로세스 전역 상태라 모듈 로드 시 1회만 호출한다.
 *
 * POPBILL_IS_TEST는 명시적으로 "false"를 줘야만 운영 전환된다 — 값이 없거나 다른
 * 문자열이면 테스트 모드로 fail-safe(실수로 운영 발행되는 사고를 막기 위함).
 */
let configured = false;

function ensureConfigured() {
  if (configured) return;

  const LinkID = process.env.POPBILL_LINK_ID;
  const SecretKey = process.env.POPBILL_SECRET_KEY;

  if (!LinkID || !SecretKey) {
    throw new PopbillNotConfiguredError();
  }

  popbill.config({
    LinkID,
    SecretKey,
    IsTest: process.env.POPBILL_IS_TEST !== "false",
    defaultErrorHandler: (error) => {
      console.error("[popbill] unhandled error", error.code, error.message);
    },
  });

  configured = true;
}

export class PopbillNotConfiguredError extends Error {
  constructor() {
    super("POPBILL_LINK_ID / POPBILL_SECRET_KEY가 설정되지 않았습니다.");
  }
}

export class PopbillApiError extends Error {
  code: number;

  constructor(error: popbill.PopbillError) {
    super(error.message);
    this.code = error.code;
  }
}

function getTaxinvoiceService(): popbill.TaxinvoiceService {
  ensureConfigured();
  return popbill.TaxinvoiceService();
}

export function checkIsMember(corpNum: string): Promise<popbill.CheckIsMemberResponse> {
  return new Promise((resolve, reject) => {
    getTaxinvoiceService().checkIsMember(
      corpNum,
      (response) => resolve(response),
      (error) => reject(new PopbillApiError(error))
    );
  });
}

export function joinMember(form: popbill.JoinMemberForm): Promise<popbill.JoinMemberResponse> {
  return new Promise((resolve, reject) => {
    getTaxinvoiceService().joinMember(
      form,
      (response) => resolve(response),
      (error) => reject(new PopbillApiError(error))
    );
  });
}

export function registIssue(
  corpNum: string,
  taxinvoice: popbill.TaxinvoiceForm,
  memo: string
): Promise<popbill.RegistIssueResponse> {
  return new Promise((resolve, reject) => {
    getTaxinvoiceService().registIssue(
      corpNum,
      taxinvoice,
      false,
      false,
      memo,
      "",
      "",
      "",
      (response) => resolve(response),
      (error) => reject(new PopbillApiError(error))
    );
  });
}

export function getInfo(corpNum: string, mgtKey: string): Promise<popbill.GetInfoResponse> {
  return new Promise((resolve, reject) => {
    getTaxinvoiceService().getInfo(
      corpNum,
      popbill.MgtKeyType.SELL,
      mgtKey,
      (response) => resolve(response),
      (error) => reject(new PopbillApiError(error))
    );
  });
}

export function cancelIssue(
  corpNum: string,
  mgtKey: string,
  memo: string
): Promise<{ code: number; message: string }> {
  return new Promise((resolve, reject) => {
    getTaxinvoiceService().cancelIssue(
      corpNum,
      popbill.MgtKeyType.SELL,
      mgtKey,
      memo,
      (response) => resolve(response),
      (error) => reject(new PopbillApiError(error))
    );
  });
}
