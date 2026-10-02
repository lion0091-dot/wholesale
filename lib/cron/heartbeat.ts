/**
 * 크론 실행 기록 — 마이그레이션 204의 cron_runs.
 * 각 크론 라우트의 핸들러를 감싸, 인증을 통과해 실제로 돈 실행의 결과(HTTP 상태)를 한 줄로 남긴다.
 * **올바른 CRON_SECRET을 실은 요청만 기록한다** — 401(틀린 비밀)과 "CRON_SECRET 미설정" 500(인증 검사보다 먼저 나가는 응답)을
 * 익명 호출이 만들어 낼 수 있으므로, 외부 호출이 "성공 시각"을 흉내 내거나 실패로 덮어쓰지 못하게 한다.
 * HTTP 200이어도 일을 안 했거나(키 미설정 등 "건너뜀") 전부 실패했으면 핸들러가 응답 헤더 x-cron-outcome으로 알린다:
 *   skipped → 마지막 성공 시각을 갱신하지 않는다(화면이 "오래 안 돎"으로 드러낸다), failed → 실패로 기록한다.
 * 기록 실패가 크론 본 작업의 결과를 바꾸면 안 되므로 오류는 삼키고 서버 로그에만 남긴다.
 *
 * 서버 전용 모듈(SUPABASE_SERVICE_ROLE_KEY 참조).
 */

import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";

type CronHandler = (request: NextRequest) => Promise<Response>;

/** 핸들러가 "200이지만 사실은 건너뜀/전부 실패"를 알리는 응답 헤더 이름과 값. */
export const CRON_OUTCOME_HEADER = "x-cron-outcome";
export type CronOutcome = "skipped" | "failed";

/** 크론 응답에 outcome 헤더를 붙여 돌려주는 JSON 응답 도우미. */
export function cronJson(body: unknown, outcome?: CronOutcome, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(outcome ? { [CRON_OUTCOME_HEADER]: outcome } : {}) },
  });
}

async function recordCronRun(job: string, status: number, detail: string | null, advanceOk?: boolean): Promise<void> {
  try {
    const supabase = createServiceRoleClient();

    if (!supabase) {
      return;
    }

    const now = new Date().toISOString();
    const ok = advanceOk ?? (status >= 200 && status < 300);

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

/** 올바른 CRON_SECRET을 실은 요청인가 — 이 요청만 "실제 크론 실행"으로 기록한다. */
export function isAuthorizedCronRequest(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;

  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export function withCronHeartbeat(job: string, handler: CronHandler): CronHandler {
  return async (request) => {
    const authorized = isAuthorizedCronRequest(request);
    let response: Response;

    try {
      response = await handler(request);
    } catch (error) {
      if (authorized) await recordCronRun(job, 500, error instanceof Error ? error.message : String(error));

      throw error;
    }

    if (!authorized) return response;

    const outcome = response.headers.get(CRON_OUTCOME_HEADER);
    let detail: string | null = null;

    if (response.status >= 400 || outcome) {
      try {
        detail = (await response.clone().text()).slice(0, 500);
      } catch {
        detail = null;
      }
    }

    if (outcome === "failed") {
      await recordCronRun(job, 500, detail);
    } else if (outcome === "skipped") {
      // 200이지만 일을 안 했다 — 마지막 성공 시각은 그대로 둔다.
      await recordCronRun(job, response.status, detail, false);
    } else {
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
  { job: "check-stock-integrity", path: "/api/cron/check-stock-integrity", label: "재고·박스·원장 일치 점검(매일)", maxAgeHours: 36 },
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
