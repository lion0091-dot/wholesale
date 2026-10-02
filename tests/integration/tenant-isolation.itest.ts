/**
 * 공급사·고객 간 섞임 방어 검사 — 아래 SQL들을 로컬 Docker DB에서 돌린다(전부 롤백).
 *  - scripts/db-test-tenant-guards.sql: 쓰기 방어(마이그레이션 200·201). 카탈로그를 읽는 구조 검사가 들어 있어, 공급사 소유 표에서
 *    다른 공급사 소유 표를 가리키는 컬럼을 새로 만들고 가드를 안 걸면 실패한다.
 *  - scripts/db-test-read-isolation.sql: 공급사·고객 계정으로 전 테이블을 훑어 남의 행이 보이는지(로컬 잔존 데이터 기준).
 *  - scripts/db-test-order-customer-isolation.sql: 공급사 A·B, 고객 R1·R2 시드로 주문·품목·맞춤단가·거래처·업로드 행 조회와 변조 시도.
 *  - scripts/db-test-anon-surface.sql: 비로그인이 실행할 수 있는 함수 허용 목록 대조(마이그레이션 202) + 공개 기능 정상 + 변경 함수 호출 거부.
 *  - scripts/db-test-all-tables-isolation.sql: wholesaler_id·retailer_id가 있는 모든 표를 카탈로그로 자동 시드해 조회·수정·삭제·삽입을 시도한다.
 *    자동 시드가 안 되는 새 표가 생기면 조용히 넘기지 않고 실패한다(OVERRIDES에 값을 적어야 한다).
 * SQL이 하나라도 FAIL/ERROR면 실패.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const NEWLINE = String.fromCharCode(10);

function runScript(path: string): { status: number | null; combined: string } {
  const script = ["begin;", readFileSync(path, "utf8"), "rollback;"].join(NEWLINE);
  // psql의 NOTICE(PASS 줄)는 stderr로 나오므로 두 출력을 합쳐서 본다.
  const run = spawnSync(
    "docker",
    ["exec", "-i", "supabase_db_wholesale", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input: script, encoding: "utf8" }
  );

  return { status: run.status, combined: [run.stdout ?? "", run.stderr ?? ""].join(NEWLINE) };
}

describe("공급사·고객 간 섞임 방어(DB)", () => {
  it("쓰기 방어: 구조 검사·교차 시도·점검 함수 검증이 전부 통과한다", () => {
    const { status, combined } = runScript("scripts/db-test-tenant-guards.sql");

    expect(status, `섞임 방어 검사 실패: ${combined}`).toBe(0);
    expect(combined).not.toMatch(/FAIL/);
    expect((combined.match(/PASS:/g) ?? []).length).toBeGreaterThanOrEqual(18);
  }, 120_000);

  it("읽기 격리: 공급사·고객 계정으로 전 테이블을 훑어도 남의 행이 안 보인다", () => {
    const { status, combined } = runScript("scripts/db-test-read-isolation.sql");

    expect(status, `읽기 격리 점검 실패: ${combined}`).toBe(0);
    expect(combined).toMatch(/PASS: 공급사·고객 계정 모두/);
  }, 120_000);

  it("주문·고객 시나리오: 공급사 A·B, 고객 R1·R2 간 조회·변조가 전부 막힌다", () => {
    const { status, combined } = runScript("scripts/db-test-order-customer-isolation.sql");

    expect(status, `주문·고객 격리 검사 실패: ${combined}`).toBe(0);
    expect(combined).not.toMatch(/FAIL/);
    expect((combined.match(/PASS:/g) ?? []).length).toBeGreaterThanOrEqual(25);
  }, 120_000);

  it("전 테이블 자동 시드 전수: 공급사 소유 표 전부 조회·수정·삭제·삽입이 막히고, 고객 소유 표도 무관한 고객이 못 건드린다", () => {
    const { status, combined } = runScript("scripts/db-test-all-tables-isolation.sql");

    expect(status, `전수 격리 점검 실패: ${combined}`).toBe(0);
    expect(combined).toMatch(/PASS: 공급사 소유 표 전부/);
    expect(combined).toMatch(/PASS: 고객 소유 컬럼 표 전부/);
  }, 180_000);

  it("비로그인 공개 표면: 실행 가능한 함수는 허용 목록뿐이고, 공개 페이지 기능은 되고, 변경 함수는 호출조차 못 한다", () => {
    const { status, combined } = runScript("scripts/db-test-anon-surface.sql");

    expect(status, `비로그인 표면 점검 실패: ${combined}`).toBe(0);
    expect(combined).not.toMatch(/FAIL/);
    expect((combined.match(/PASS:/g) ?? []).length).toBeGreaterThanOrEqual(16);
  }, 120_000);
});
