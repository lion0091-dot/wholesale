/**
 * 서버 액션 통합테스트 공통 준비 — 로컬 Docker Supabase 전용.
 * .env.local(라이브 프로젝트를 가리킬 수 있음)은 읽지 않고, 접속 주소를 로컬로 못 박는다.
 */
import { vi } from "vitest";
import { getActorClient } from "./harness";

const LOCAL_URL = process.env.INTEGRATION_SUPABASE_URL ?? "http://127.0.0.1:54321";

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(LOCAL_URL)) {
  throw new Error(`통합테스트는 로컬 Supabase에만 붙을 수 있습니다: ${LOCAL_URL}`);
}

// 지금 Supabase CLI가 발급하는 로컬 개발용 공개 데모 키(외부 접근 불가, 로컬 컨테이너 전용).
const DEMO_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const DEMO_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.INTEGRATION_SUPABASE_ANON_KEY ?? DEMO_ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.INTEGRATION_SUPABASE_SERVICE_KEY ?? DEMO_SERVICE_KEY;
process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(63) + "1";
delete process.env.SWEETTRACKER_API_KEY;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => getActorClient(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
