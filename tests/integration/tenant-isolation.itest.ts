/**
 * 공급사 간 섞임 방어 검사 — scripts/db-test-tenant-guards.sql(마이그레이션 200)을 로컬 Docker DB에서 돌린다(전부 롤백).
 * 카탈로그를 읽는 구조 검사가 들어 있어, 공급사 소유 표에서 다른 공급사 소유 표를 가리키는 컬럼을 새로 만들고
 * 가드를 안 걸면 이 테스트가 실패한다. SQL이 하나라도 FAIL/ERROR면 실패.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("공급사 간 섞임 방어(DB 가드)", () => {
  it("구조 검사·교차 시도·점검 함수 검증이 전부 통과한다", () => {
    const script = ["begin;", readFileSync("scripts/db-test-tenant-guards.sql", "utf8"), "rollback;"].join("\n");
    // psql의 NOTICE(PASS 줄)는 stderr로 나오므로 두 출력을 합쳐서 본다.
    const run = spawnSync(
      "docker",
      ["exec", "-i", "supabase_db_wholesale", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"],
      { input: script, encoding: "utf8" }
    );
    const combined = `${run.stdout ?? ""}
${run.stderr ?? ""}`;

    expect(run.status, `섞임 방어 검사 실패:
${combined}`).toBe(0);
    expect(combined).not.toMatch(/FAIL/);
    expect((combined.match(/PASS:/g) ?? []).length).toBeGreaterThanOrEqual(15);
  }, 120_000);
});
