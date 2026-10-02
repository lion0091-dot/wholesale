/**
 * 어드민 [공급사 승인] 화면 맨 위 "지금 할 일" 카드의 판단 로직.
 *
 * 공급사 쪽 카드(lib/supplier/onboarding-next-step.ts)와 짝이다. 운영팀이 "어느 공급사를 먼저, 무엇을" 해야 하는지
 * 목록을 훑지 않고 알게 한다. 운영팀이 할 수 있는 일(승인·진위확인)을 먼저, 공급사 응답을 기다려야 하는 건은
 * 개수로만 알려 준다. 할 일이 없을 때는 "없다"고 분명히 말한다(할 일 없음도 안내다).
 *
 * 우선순위: ① 국세청 일치 → 입점 승인(본인 명의가 아닌 건) ② 진위확인 미실행/API 오류 → 진위확인 실행
 * ③ 구독료 미납(영업중) → 이용 일시정지 여부 결정. 같은 순위에서는 신청이 오래된 공급사부터.
 * 공급사 응답 대기: 번호 미제출·체크섬 오류·개업일자 없음·국세청 불일치/미등록·본인 명의라 다른 관리자가 승인해야 하는 건.
 */

import { isValidBusinessNumber } from "@/lib/validation/business-number";

export interface AdminSupplierRow {
  id: string;
  businessName: string;
  status: string;
  profileId: string | null;
  businessNumber: string | null;
  businessStartDate: string | null;
  /** unchecked | match | mismatch | not_found | error */
  ntsStatus: string | null;
  subscriptionStatus: string | null;
  createdAt: string;
}

export type AdminNextStepKey = "approve" | "verify" | "overdue" | "nothing";

export interface AdminNextStep {
  key: AdminNextStepKey;
  /** 먼저 열어 볼 공급사. nothing이면 null */
  supplierId: string | null;
  title: string;
  detail: string;
  /** null이면 버튼 없이 안내만 한다 */
  buttonLabel: string | null;
}

type PendingKind = "approve" | "verify" | "waiting-supplier" | "waiting-other-admin";

/** 승인 대기 공급사 한 곳이 지금 누구의 차례인지. */
export function classifyPendingSupplier(row: AdminSupplierRow, currentUserId: string | null): PendingKind {
  if (!row.businessNumber || !isValidBusinessNumber(row.businessNumber) || !row.businessStartDate) {
    return "waiting-supplier";
  }

  const nts = row.ntsStatus ?? "unchecked";

  if (nts === "mismatch" || nts === "not_found") return "waiting-supplier";

  if (nts === "match") {
    // 자기승인 차단 — 본인 명의로 신청한 업체는 다른 관리자가 승인해야 한다(updateSupplierStatusAction과 같은 규칙).
    return currentUserId && row.profileId === currentUserId ? "waiting-other-admin" : "approve";
  }

  return "verify"; // unchecked 또는 error
}

const byOldest = (a: AdminSupplierRow, b: AdminSupplierRow) => a.createdAt.localeCompare(b.createdAt);

export function pickAdminSupplierNextStep(rows: AdminSupplierRow[], currentUserId: string | null): AdminNextStep {
  const pending = rows.filter((row) => row.status === "pending").sort(byOldest);
  const classified = pending.map((row) => ({ row, kind: classifyPendingSupplier(row, currentUserId) }));
  const approve = classified.filter((item) => item.kind === "approve");
  const verify = classified.filter((item) => item.kind === "verify");
  const waitingSupplier = classified.filter((item) => item.kind === "waiting-supplier").length;
  const waitingOtherAdmin = classified.filter((item) => item.kind === "waiting-other-admin").length;
  const overdue = rows.filter((row) => row.status === "active" && row.subscriptionStatus === "overdue").sort(byOldest);

  const waitingNote = (() => {
    const parts: string[] = [];

    if (waitingSupplier > 0) parts.push(`공급사 응답 대기 ${waitingSupplier}건(번호 미제출·불일치 등)`);
    if (waitingOtherAdmin > 0) parts.push(`다른 관리자 승인 대기 ${waitingOtherAdmin}건(본인 명의)`);

    return parts.length > 0 ? ` 그 밖에 ${parts.join(", ")}.` : "";
  })();

  const actionable = approve.length + verify.length;
  const moreNote = (count: number) => (count > 1 ? ` 이 단계의 다른 건이 ${count - 1}건 더 있습니다.` : "");

  if (approve.length > 0) {
    const first = approve[0].row;

    return {
      key: "approve",
      supplierId: first.id,
      title: `${first.businessName} 입점을 승인하세요`,
      detail: `국세청 진위확인이 일치입니다. 구독 상태를 정하고 [입점 승인]을 누르세요.${moreNote(approve.length)}${actionable > approve.length ? ` 진위확인을 기다리는 건 ${verify.length}건.` : ""}${waitingNote}`,
      buttonLabel: "승인하러 가기",
    };
  }

  if (verify.length > 0) {
    const first = verify[0].row;

    return {
      key: "verify",
      supplierId: first.id,
      title: `${first.businessName} 국세청 진위확인을 실행하세요`,
      detail: `번호·개업일자가 제출됐습니다. [국세청 진위확인 실행]을 누르면 결과가 바로 나옵니다.${moreNote(verify.length)}${waitingNote}`,
      buttonLabel: "진위확인하러 가기",
    };
  }

  if (overdue.length > 0) {
    const first = overdue[0];

    return {
      key: "overdue",
      supplierId: first.id,
      title: `구독료 미납 공급사 ${overdue.length}곳을 확인하세요`,
      detail: `${first.businessName}부터 입금을 확인하고, 유예 기간이 지났으면 [이용 일시정지]를 누르세요.${waitingNote}`,
      buttonLabel: "미납 공급사 열기",
    };
  }

  return {
    key: "nothing",
    supplierId: null,
    title: "지금 처리할 건이 없습니다",
    detail: waitingNote ? `운영팀이 할 일은 없습니다.${waitingNote}` : "승인 대기, 진위확인, 미납 건이 모두 처리됐습니다.",
    buttonLabel: null,
  };
}
