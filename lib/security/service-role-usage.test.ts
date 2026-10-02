/**
 * 서비스키(RLS 우회) 사용처 가드 — 2026-10-02 점검에서 21개 경로를 전부 읽고 소속 검사를 확인했다.
 * 이 테스트는 그 상태를 고정한다:
 *  1) createServiceRoleClient()를 쓰는 파일이 아래 목록에 없으면 실패 — 새 사용처는 "공급사·고객 소속을 세션/서명 토큰에서
 *     얻는지"를 사람이 읽고 확인한 뒤 목록에 추가해야 한다(docs/tenant-isolation-runbook.md 6절).
 *  2) 크론 라우트는 전부 CRON_SECRET 미설정 시 거부 + Bearer 검증을 해야 한다(안 하면 누구나 호출해 서비스키 작업을 돌릴 수 있다).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** 점검 완료(2026-10-02). 값은 소속·권한이 어디서 정해지는지 한 줄. */
const REVIEWED: Record<string, string> = {
  "app/actions/buyer-auth.ts": "탈퇴 — 세션 user.id만 대상",
  "app/actions/supplier-auth.ts": "탈퇴 — 세션 user.id만 대상",
  "app/actions/push-subscription.ts": "구독 저장 — user_id·wholesaler_id는 세션에서만(endpoint만 입력)",
  "app/admin/admins/actions.ts": "관리자 부여·회수 — can_current_user_grant_admin 이중 검증, fail-closed",
  "app/auth/callback/route.ts": "로그인 콜백 — 교환된 세션 user.id만",
  "app/doc/[token]/route.ts": "서명 토큰(HMAC, 10분) — 주문 조회에 wholesaler_id(·retailer_id) 조건",
  "lib/auth/dev-org.ts": "개발용 — NODE_ENV=production이면 항상 비활성",
  "lib/auth/super-admin-bootstrap.ts": "SUPER_ADMIN_EMAIL 세션 이메일 일치 시에만",
  "lib/livestock/master-cache.ts": "공용 이력 캐시 — 공공 API 응답만 저장(사용자 입력 아님)",
  "lib/notifications/alimtalk.ts": "발송 — 호출부가 인가된 주문·거래처의 wholesalerId를 넘김",
  "lib/notifications/web-push.ts": "발송 — wholesalerId는 호출부(주문 처리)에서",
  "lib/security/access-log.ts": "접속기록 — 세션 userId",
  "lib/cron/heartbeat.ts": "크론 실행 기록 — 작업 이름·상태 코드만 쓴다(인증 통과한 크론 핸들러 래퍼, 401은 기록 안 함)",
  "lib/security/wholesaler-credentials.ts": "자격정보 — 호출부가 세션 scope 또는 본인 행 확인 후 id를 넘김",
  "app/api/cron/check-tenant-consistency/route.ts": "크론(CRON_SECRET)",
  "app/api/cron/check-stock-integrity/route.ts": "크론(CRON_SECRET)",
  "app/api/cron/expire-retailer-invites/route.ts": "크론(CRON_SECRET)",
  "app/api/cron/finalize-subscription-invoices/route.ts": "크론(CRON_SECRET)",
  "app/api/cron/market-price-sync/route.ts": "크론(CRON_SECRET)",
  "app/api/cron/purge-expired-personal-data/route.ts": "크론(CRON_SECRET)",
  "app/api/cron/purge-unconsented-accounts/route.ts": "크론(CRON_SECRET)",
  "app/api/cron/reconcile-pg-payments/route.ts": "크론(CRON_SECRET)",
  "app/api/cron/retry-trace-lookups/route.ts": "크론(CRON_SECRET)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;

    const full = join(dir, name);

    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.itest\.ts$/.test(name)) {
      out.push(full);
    }
  }

  return out;
}

const rel = (path: string) => relative(ROOT, path).split("\\").join("/");

describe("서비스키 사용처 가드", () => {
  const sources = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].filter((path) => rel(path) !== "lib/supabase/service-role-client.ts");

  it("createServiceRoleClient를 쓰는 파일은 전부 점검 목록에 있다", () => {
    const users = sources.filter((path) => readFileSync(path, "utf8").includes("createServiceRoleClient(")).map(rel).sort();
    const unreviewed = users.filter((path) => !(path in REVIEWED));

    expect(unreviewed, `새 서비스키 사용처 — 소속을 세션/서명 토큰에서 얻는지 읽고 확인한 뒤 REVIEWED에 추가하세요: ${unreviewed.join(", ")}`).toEqual([]);
  });

  it("점검 목록에 있는 파일이 실제로 서비스키를 쓴다(없어진 항목은 정리)", () => {
    const stale = Object.keys(REVIEWED).filter((path) => !readFileSync(join(ROOT, path), "utf8").includes("createServiceRoleClient("));

    expect(stale).toEqual([]);
  });

  it("모든 크론 라우트는 CRON_SECRET 미설정 거부 + Bearer 검증을 한다", () => {
    const crons = sources.filter((path) => /^app\/api\/cron\/.+\/route\.ts$/.test(rel(path)));

    expect(crons.length).toBeGreaterThan(0);

    for (const path of crons) {
      const text = readFileSync(path, "utf8");

      expect(text, `${rel(path)}: CRON_SECRET 미설정 거부가 없다`).toMatch(/process\.env\.CRON_SECRET/);
      expect(text, `${rel(path)}: Bearer 검증이 없다`).toMatch(/authorization["']\)\s*!==\s*`Bearer \$\{cronSecret\}`/);
    }
  });
});
