/**
 * Supabase 접속 헬퍼 (일회성 도구).
 *
 * 직접 연결(db.<ref>.supabase.co)은 이 환경에서 DNS 해석이 되지 않으므로
 * 같은 자격증명으로 풀러(pooler) 세션 모드에 접속한다.
 * 비밀번호/URL 은 절대 출력하지 않는다.
 *
 * 의존성: pg 드라이버가 필요하다 (런타임 의존성이 아니므로 package.json 에 넣지 않는다).
 *   npm install --no-save pg
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const POOLER_HOST = "aws-0-ap-northeast-2.pooler.supabase.com";

export function loadConnectionCandidates() {
  const env = readFileSync(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL=(.*)$/m);

  if (!match) {
    throw new Error(".env.local 에 DATABASE_URL 이 없습니다.");
  }

  const direct = new URL(match[1].trim().replace(/^"|"$/g, ""));
  const ref = direct.hostname.replace(/^db\./, "").replace(/\.supabase\.co$/, "");
  const password = decodeURIComponent(direct.password);

  const base = { database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 };

  return [
    { label: "direct:5432", config: { ...base, host: direct.hostname, port: 5432, user: "postgres", password } },
    { label: "pooler-session:5432", config: { ...base, host: POOLER_HOST, port: 5432, user: `postgres.${ref}`, password } },
    { label: "pooler-txn:6543", config: { ...base, host: POOLER_HOST, port: 6543, user: `postgres.${ref}`, password } },
  ];
}

/** 사용 가능한 첫 접속을 돌려준다. */
export async function connect() {
  const errors = [];

  for (const { label, config } of loadConnectionCandidates()) {
    const client = new pg.Client(config);

    try {
      await client.connect();
      console.log(`[connect] ${label} 접속 성공`);

      return client;
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      await client.end().catch(() => {});
    }
  }

  throw new Error(`모든 접속 경로 실패\n - ${errors.join("\n - ")}`);
}
