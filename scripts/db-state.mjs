/**
 * 적용 후 최종 상태 확인 (읽기 전용).
 * 의존성: npm install --no-save pg
 */
import { connect } from "./db-connect.mjs";

const client = await connect();

const { rows: history } = await client.query(
  `SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version`
);
console.log("\n### 마이그레이션 이력");
console.table(history);

const { rows: counts } = await client.query(
  `SELECT
     (SELECT count(*) FROM auth.users) AS auth_users,
     (SELECT count(*) FROM public.profiles) AS profiles,
     (SELECT count(*) FROM public.wholesalers) AS wholesalers,
     (SELECT count(*) FROM public.retailers) AS retailers,
     (SELECT count(*) FROM public.organizations) AS organizations`
);
console.log("\n### 행 수 (테스트 데이터가 남지 않았는지 확인)");
console.table(counts);

await client.end();
