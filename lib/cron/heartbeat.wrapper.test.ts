import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upserts: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);

        return { error: null };
      },
    }),
  }),
}));

import { cronJson, withCronHeartbeat } from "./heartbeat";

const request = (authorization?: string) => new NextRequest("http://localhost/api/cron/x", { headers: authorization ? { authorization } : {} });

describe("withCronHeartbeat — 무엇을 기록하나", () => {
  beforeEach(() => {
    upserts.length = 0;
    process.env.CRON_SECRET = "secret-value-1234";
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("틀린 비밀·비밀 없음 요청은 기록하지 않는다(익명 호출이 상태를 덮어쓰지 못함)", async () => {
    const handler = withCronHeartbeat("job", async () => new Response("unauthorized", { status: 401 }));

    await handler(request("Bearer wrong"));
    await handler(request());

    expect(upserts).toEqual([]);
  });

  it("CRON_SECRET 미설정 500도 익명 호출로는 기록되지 않는다", async () => {
    delete process.env.CRON_SECRET;

    const handler = withCronHeartbeat("job", async () => new Response("config error", { status: 500 }));

    await handler(request());
    await handler(request("Bearer undefined"));

    expect(upserts).toEqual([]);
  });

  it("올바른 비밀로 성공하면 마지막 성공 시각을 갱신한다", async () => {
    await withCronHeartbeat("job", async () => new Response("ok"))(request("Bearer secret-value-1234"));

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ job: "job", last_status: 200 });
    expect(upserts[0]).toHaveProperty("last_ok_at");
  });

  it("올바른 비밀로 실패(500)하면 마지막 성공 시각을 건드리지 않고 사유를 남긴다", async () => {
    await withCronHeartbeat("job", async () => new Response("boom", { status: 500 }))(request("Bearer secret-value-1234"));

    expect(upserts[0]).toMatchObject({ job: "job", last_status: 500, last_detail: "boom" });
    expect(upserts[0]).not.toHaveProperty("last_ok_at");
  });

  it("200이어도 skipped 표시면 마지막 성공 시각을 갱신하지 않는다", async () => {
    await withCronHeartbeat("job", async () => cronJson({ skipped: true, reason: "키 미설정" }, "skipped"))(request("Bearer secret-value-1234"));

    expect(upserts[0]).toMatchObject({ last_status: 200 });
    expect(upserts[0]).not.toHaveProperty("last_ok_at");
    expect(String(upserts[0].last_detail)).toContain("키 미설정");
  });

  it("200이어도 failed 표시면 실패(500)로 기록한다", async () => {
    await withCronHeartbeat("job", async () => cronJson({ results: [] }, "failed"))(request("Bearer secret-value-1234"));

    expect(upserts[0]).toMatchObject({ last_status: 500 });
    expect(upserts[0]).not.toHaveProperty("last_ok_at");
  });

  it("핸들러가 예외를 던지면 500으로 기록하고 그대로 다시 던진다", async () => {
    const handler = withCronHeartbeat("job", async () => {
      throw new Error("db down");
    });

    await expect(handler(request("Bearer secret-value-1234"))).rejects.toThrow("db down");
    expect(upserts[0]).toMatchObject({ last_status: 500, last_detail: "db down" });
  });

  it("비밀 없는 요청에서 핸들러가 예외를 던져도 기록하지 않는다", async () => {
    const handler = withCronHeartbeat("job", async () => {
      throw new Error("x");
    });

    await expect(handler(request())).rejects.toThrow("x");
    expect(upserts).toEqual([]);
  });
});
