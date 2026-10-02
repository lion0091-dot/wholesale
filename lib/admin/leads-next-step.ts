/**
 * 어드민 [입점 리드] 화면 맨 위 "지금 할 일" 카드의 판단 로직(순수 함수).
 *
 * 리드는 알고리즘 매칭이 아니라 운영팀이 적합한 공급사에 직접 연락해 의뢰하고 기록하는 것이다. 카드는
 * "가장 오래 기다린 대기중 신청부터" 처리하게 하고, 할 일이 없으면 없다고 말한다.
 */

export interface AdminLeadRow {
  id: string;
  restaurantName: string;
  region: string | null;
  desiredCategory: string | null;
  /** pending | contacted | matched | closed */
  status: string;
  createdAt: string;
}

export interface AdminLeadsNextStep {
  key: "contact" | "nothing";
  /** 먼저 열어 볼 신청. nothing이면 null */
  leadId: string | null;
  title: string;
  detail: string;
  buttonLabel: string | null;
}

export function pickAdminLeadsNextStep(leads: AdminLeadRow[]): AdminLeadsNextStep {
  const pending = leads.filter((lead) => lead.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const contacted = leads.filter((lead) => lead.status === "contacted").length;

  if (pending.length > 0) {
    const first = pending[0];
    const hint = [first.region, first.desiredCategory].filter(Boolean).join(" · ");

    return {
      key: "contact",
      leadId: first.id,
      title: `연락하지 않은 입점 신청이 ${pending.length}건 있습니다`,
      detail: `가장 오래 기다린 ${first.restaurantName}${hint ? `(${hint})` : ""}부터 적합한 공급사에 연락해 의뢰하세요. 연락했으면 상태를 [공급사 컨택중]으로 바꾸고 메모를 적어 [저장]하세요.${contacted > 0 ? ` 이미 컨택중인 ${contacted}건은 회신을 기다리는 중입니다.` : ""}`,
      buttonLabel: "첫 신청으로 가기",
    };
  }

  return {
    key: "nothing",
    leadId: null,
    title: "연락할 신청이 없습니다",
    detail:
      contacted > 0
        ? `새 신청이 없습니다. 공급사 컨택중 ${contacted}건은 회신을 확인해 [매칭 완료] 또는 [종료(보류)]로 바꿔 두세요.`
        : "대기중인 입점 신청이 없습니다. 할 일이 없습니다.",
    buttonLabel: null,
  };
}
