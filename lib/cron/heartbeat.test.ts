import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CRON_JOBS, evaluateCronHealth } from "./heartbeat";

const NOW = new Date("2026-10-02T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe("evaluateCronHealth", () => {
  it("기록이 없으면 never", () => {
    expect(evaluateCronHealth(null, 36, NOW)).toBe("never");
  });

  it("기준 시간 안에 성공했으면 ok", () => {
    expect(evaluateCronHealth({ last_run_at: hoursAgo(5), last_ok_at: hoursAgo(5), last_status: 200 }, 36, NOW)).toBe("ok");
  });

  it("마지막 성공이 기준보다 오래됐으면 stale(호출이 안 온 경우)", () => {
    expect(evaluateCronHealth({ last_run_at: hoursAgo(40), last_ok_at: hoursAgo(40), last_status: 200 }, 36, NOW)).toBe("stale");
  });

  it("최근 실행이 실패면 failing — 이전 성공이 최근이어도", () => {
    expect(evaluateCronHealth({ last_run_at: hoursAgo(1), last_ok_at: hoursAgo(25), last_status: 500 }, 36, NOW)).toBe("failing");
  });

  it("성공 시각이 비어 있으면 stale", () => {
    expect(evaluateCronHealth({ last_run_at: hoursAgo(1), last_ok_at: null, last_status: 200 }, 36, NOW)).toBe("stale");
  });
});

describe("크론 목록 일치", () => {
  const routeDirs = readdirSync(join(process.cwd(), "app", "api", "cron")).sort();
  const vercelCrons = (JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")).crons as Array<{ path: string }>).map((cron) => cron.path).sort();

  it("vercel.json의 크론과 CRON_JOBS가 같다", () => {
    expect(CRON_JOBS.map((job) => job.path).sort()).toEqual(vercelCrons);
  });

  it("모든 크론 라우트가 withCronHeartbeat로 자기 이름을 기록한다", () => {
    for (const dir of routeDirs) {
      const text = readFileSync(join(process.cwd(), "app", "api", "cron", dir, "route.ts"), "utf8");

      expect(text, `${dir}: withCronHeartbeat("${dir}", ...)로 감싸지 않았다`).toContain(`withCronHeartbeat("${dir}", handler)`);
    }
  });
});
