/**
 * 대기 중인 마이그레이션을 순서대로 적용한다 (일회성 도구).
 *
 * 각 파일은 하나의 트랜잭션으로 실행하고, 성공 시
 * supabase_migrations.schema_migrations 에 이력을 남긴다.
 * (실패하면 해당 파일 전체가 롤백되고 즉시 중단한다)
 */
import { readFileSync } from "node:fs";
import { connect } from "./db-connect.mjs";

const targets = process.argv.slice(2);

if (targets.length === 0) {
  throw new Error("적용할 마이그레이션 버전을 인수로 지정하세요. 예: node scripts/db-apply-migrations.mjs 20260913000000_kakao_buyer_auth");
}

const client = await connect();

const { rows: historyColumns } = await client.query(
  `SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_schema='supabase_migrations' AND table_name='schema_migrations'`
);

console.log("[history columns]", JSON.stringify(historyColumns));

const hasStatements = historyColumns.some((column) => column.column_name === "statements");
const hasName = historyColumns.some((column) => column.column_name === "name");

for (const target of targets) {
  const path = `supabase/migrations/${target}.sql`;
  const sql = readFileSync(path, "utf8");
  const version = target.split("_")[0];
  const name = target.slice(version.length + 1);

  console.log(`\n=== 적용 시작: ${target} ===`);

  try {
    await client.query("BEGIN");
    await client.query(sql);

    const columns = ["version"];
    const values = [version];

    if (hasName) {
      columns.push("name");
      values.push(name);
    }

    if (hasStatements) {
      columns.push("statements");
      values.push([sql]);
    }

    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
       ON CONFLICT (version) DO NOTHING`,
      values
    );

    await client.query("COMMIT");
    console.log(`=== 적용 완료: ${target} ===`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`=== 적용 실패(롤백): ${target} ===`);
    console.error(error.message);
    if (error.position) {
      const position = Number(error.position);
      console.error("문제 지점 주변:\n" + sql.slice(Math.max(0, position - 300), position + 300));
    }
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log("\n모든 마이그레이션 적용 완료");
