import { PillTabs } from "./pill-tabs";

const TABS = [
  { label: "초대장 · 업체 설정", href: "/dashboard/invites" },
  { label: "팀원", href: "/dashboard/team" },
  { label: "구독료", href: "/dashboard/billing" },
] as const;

/** 사이드바의 "설정" 메뉴 하나로 묶인 세 화면(초대장·업체 설정 / 팀원 / 구독료)의 공통 머리. */
export function SettingsHeader() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>설정</h1>
      <PillTabs tabs={TABS} ariaLabel="설정 종류" />
    </div>
  );
}
