import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { CRON_JOBS, evaluateCronHealth, type CronHealth, type CronRunRow } from "@/lib/cron/heartbeat";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<CronHealth, { label: string; color: string; background: string }> = {
  ok: { label: "정상", color: "#166534", background: "#dcfce7" },
  failing: { label: "실패", color: "#991b1b", background: "#fee2e2" },
  stale: { label: "오래 안 돎", color: "#991b1b", background: "#fee2e2" },
  never: { label: "기록 없음", color: "#475569", background: "#f1f5f9" },
};

function formatKst(iso: string | null | undefined): string {
  if (!iso) {
    return "-";
  }

  return new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export default async function AdminCronHealthPage() {
  if (!isSupabaseConfigured() || !(await isSuperAdminSession())) {
    redirect("/login?next=/admin/cron-health");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.from("cron_runs").select("job, last_run_at, last_ok_at, last_status, last_detail");
  const rows = new Map((data ?? []).map((row) => [row.job as string, row as CronRunRow & { last_detail: string | null }]));
  const now = new Date();

  // 다른 작업은 기록이 있는데 이 작업만 한 번도 없다 = 호출이 아예 안 오는 것(경로 오타·vercel.json 누락·배포 누락).
  // 표가 통째로 비어 있으면(마이그 직후·새 배포 직후) 아직 판단할 수 없으니 "기록 없음"(회색)으로 둔다.
  const anyRecorded = rows.size > 0;

  const items = CRON_JOBS.map((job) => {
    const row = rows.get(job.job);
    const health = !row && anyRecorded ? ("stale" as const) : evaluateCronHealth(row, job.maxAgeHours, now);

    return { ...job, row, health };
  });
  const problemCount = items.filter((item) => item.health === "failing" || item.health === "stale").length;

  return (
    <div style={{ maxWidth: "768px", margin: "0 auto" }}>
      <header style={{ marginBottom: "24px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px", marginBottom: "8px" }}>
          자동 작업(크론) 상태
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6 }}>
          매일·매주 자동으로 도는 작업이 마지막으로 성공한 시각입니다. 실패했거나 정해진 시간 넘게 안 돌면 빨간색으로 표시됩니다.
          Vercel은 크론이 실패해도 알려주지 않고 다시 시도하지도 않아서 이 화면으로 확인합니다.
        </p>
      </header>

      {error ? (
        <p style={{ fontSize: "13px", color: "#991b1b", marginBottom: "16px" }}>기록을 불러오지 못했습니다: {error.message}</p>
      ) : (
        <p
          style={{
            fontSize: "14px",
            fontWeight: 700,
            marginBottom: "16px",
            color: problemCount > 0 ? "#991b1b" : "#166534",
          }}
        >
          {problemCount > 0 ? `확인이 필요한 작업 ${problemCount}건` : "문제 있는 작업 없음"}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {items.map((item) => {
          const style = STATUS_STYLE[item.health];

          return (
            <div key={item.job} style={{ border: "1px solid #e2e8f0", borderRadius: "10px", padding: "12px 14px", backgroundColor: "#ffffff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>{item.label}</span>
                <span style={{ fontSize: "12px", fontWeight: 700, color: style.color, backgroundColor: style.background, borderRadius: "999px", padding: "3px 10px" }}>
                  {style.label}
                </span>
              </div>
              <p style={{ fontSize: "12px", color: "#64748b", marginTop: "6px", lineHeight: 1.6 }}>
                마지막 성공 {formatKst(item.row?.last_ok_at)} · 마지막 실행 {formatKst(item.row?.last_run_at)} (한국시간)
                {item.row && item.health === "failing" ? ` · 응답 ${item.row.last_status}` : ""}
              </p>
              {!item.row && item.health === "stale" ? (
                <p style={{ fontSize: "12px", color: "#991b1b", marginTop: "4px" }}>한 번도 실행 기록이 없습니다(다른 작업은 돌고 있습니다). 크론 등록·경로를 확인하세요.</p>
              ) : null}
              {(item.health === "failing" || item.health === "stale") && item.row?.last_detail ? (
                <p style={{ fontSize: "12px", color: "#991b1b", marginTop: "4px", wordBreak: "break-all" }}>{item.row.last_detail}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
