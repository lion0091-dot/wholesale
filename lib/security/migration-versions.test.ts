/**
 * 마이그레이션 파일의 버전(앞의 숫자)은 유일해야 한다. 2026-10-02에 `20260930000181`이 두 파일에 중복돼 있어
 * `supabase db reset`(새 DB를 마이그레이션만으로 다시 만드는 복구 경로)이 181번에서 멈췄다 — 두 번째를 203으로 옮겨 고쳤다.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("마이그레이션 버전", () => {
  it("버전 번호가 중복되지 않는다", () => {
    const files = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((name) => name.endsWith(".sql"));
    const seen = new Map<string, string[]>();

    for (const name of files) {
      const version = name.split("_")[0];

      seen.set(version, [...(seen.get(version) ?? []), name]);
    }

    const duplicates = [...seen.entries()].filter(([, names]) => names.length > 1);

    expect(duplicates, `같은 버전을 쓰는 마이그레이션: ${JSON.stringify(duplicates)}`).toEqual([]);
  });
});
