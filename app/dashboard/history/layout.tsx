import { HistoryTabs } from "./history-tabs";

export default function HistoryLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>이력 관리</h1>
      </header>

      <HistoryTabs />

      {children}
    </div>
  );
}
