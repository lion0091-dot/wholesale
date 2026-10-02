/**
 * 크론 실행 기록 — 마이그레이션 204의 cron_runs.
 * 각 크론 라우트의 핸들러를 감싸, 인증을 통과해 실제로 돈 실행의 결과(HTTP 상태)를 한 줄로 남긴다.
 * 401(인증 실패)은 기록하지 않는다 — 외부 호출이 "성공 시각"을 흉내 내거나 실패로 덮어쓰지 못하게.
 * 기록 실패가 크론 본 작업의 결과를 바꾸면 안 되므로 오류는 삼키고 서버 로그에만 남긴다.
 *
 * 서버 전용 모듈(SUPABASE_SERVICE_ROLE_KEY 참조).
 */

import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";

type CronHandler = (request: NextRequest) => Promise<Response>;

async function recordCronRun(job: string, status: number, detail: string | null): Promise<void> {
  try {
    const supabase = createServiceRoleClient();

    if (!supabase) {
      return;
    }

    const now = new Date().toISOString();
    const ok = status >= 200 && status < 300;

    // last_ok_at은 성공일 때만 갱신한다 — 실패 때는 건드리지 않아 "마지막 성공"이 보존된다.
    const { error } = await supabase.from("cron_runs").upsert(
      {
        job,
        last_run_at: now,
        last_status: status,
        last_detail: detail ? detail.slice(0, 500) : null,
        ...(ok ? { last_ok_at: now } : {}),
      },
      { onConflict: "job" }
    );

    if (error) {
      console.error(`[cron-heartbeat] ${job} 기록 실패:`, error.message);
    }
  } catch (error) {
    console.error(`[cron-heartbeat] ${job} 기록 중 예외:`, error instanceof Error ? error.message : error);
  }
}

export function withCronHeartbeat(job: string, handler: CronHandler): CronHandler {
  return async (request) => {
    let response: Response;

    try {
      response = await handler(request);
    } catch (error) {
      await recordCronRun(job, 500, error instanceof Error ? error.message : String(error));

      throw error;
    }

    // 401 = 인증 실패(크론이 아닌 외부 호출). 기록하지 않는다.
    if (response.status !== 401) {
      let detail: string | null = null;

      if (response.status >= 400) {
        try {
          detail = (await response.clone().text()).slice(0, 500);
        } catch {
          detail = null;
        }
      }

      await recordCronRun(job, response.status, detail);
    }

    return response;
  };
}

/**
 * 화면(/admin/cron-health)이 "얼마나 오래 성공이 없으면 이상인가"를 판단하는 기준.
 * vercel.json의 주기보다 여유를 둔다(매일 크론은 36시간 — 하루 한 번의 지연은 허용하고 이틀째 빠지면 이상으로 본다).
 * vercel.json의 크론을 추가·삭제하면 여기도 같이 고친다(cron-heartbeat.test.ts가 어긋남을 잡는다).
 */
export const CRON_JOBS: Array<{ job: string; path: string; label: string; maxAgeHours: number }> = [
  { job: "market-price-sync", path: "/api/cron/market-price-sync", label: "경락가 시세 동기화(매일)", maxAgeHours: 36 },
  { job: "finalize-subscription-invoices", path: "/api/cron/finalize-subscription-invoices", label: "구독료 청구서 확정(매월 1일)", maxAgeHours: 24 * 33 },
  { job: "reconcile-pg-payments", path: "/api/cron/reconcile-pg-payments", label: "PG 결제 재대조(매일)", maxAgeHours: 36 },
  { job: "retry-trace-lookups", path: "/api/cron/retry-trace-lookups", label: "이력 조회 재시도(매일)", maxAgeHours: 36 },
  { job: "expire-retailer-invites", path: "/api/cron/expire-retailer-invites", label: "고객 초대 만료(매일)", maxAgeHours: 36 },
  { job: "purge-unconsented-accounts", path: "/api/cron/purge-unconsented-accounts", label: "가입 미완료 계정 삭제(매일)", maxAgeHours: 36 },
  { job: "check-tenant-consistency", path: "/api/cron/check-tenant-consistency", label: "공급사 간 데이터 섞임 점검(매일)", maxAgeHours: 36 },
  { job: "purge-expired-personal-data", path: "/api/cron/purge-expired-personal-data", label: "탈퇴 5년 경과 개인정보 파기(매주)", maxAgeHours: 24 * 8 },
];

export type CronHealth = "ok" | "failing" | "stale" | "never";

export interface CronRunRow {
  last_run_at: string;
  last_ok_at: string | null;
  last_status: number;
}

/**
 * 한 크론의 상태를 판정한다.
 * - never: 아직 기록이 없다(배포 직후이거나 한 번도 안 돌았다) — 빨간색이 아니라 회색으로 보여준다.
 * - failing: 가장 최근 실행이 실패(2xx가 아님).
 * - stale: 최근 실행은 성공이었지만, 마지막 성공이 기준 시간보다 오래됐다(= 그 뒤로 호출이 안 왔다).
 */
export function evaluateCronHealth(row: CronRunRow | null | undefined, maxAgeHours: number, now: Date = new Date()): CronHealth {
  if (!row) {
    return "never";
  }

  if (row.last_status < 200 || row.last_status >= 300) {
    return "failing";
  }

  const lastOk = row.last_ok_at ? Date.parse(row.last_ok_at) : Number.NaN;

  if (!Number.isFinite(lastOk) || now.getTime() - lastOk > maxAgeHours * 60 * 60 * 1000) {
    return "stale";
  }

  return "ok";
}
