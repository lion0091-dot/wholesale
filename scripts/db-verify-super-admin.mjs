/**
 * 슈퍼관리자 부트스트랩 검증 (일회성 도구).
 *
 * 확인 항목:
 *   1. bootstrap_super_admin 의 EXECUTE 권한이 service_role 하나로 좁혀졌는지
 *   2. 자기 승격 차단 트리거에 전용 예외 플래그가 반영됐는지
 *   3. UUID ↔ 이메일 결속 검증 (가짜 조합 / 교차 승격 거절)
 *   4. 실제 계정 승격 경로 — 트랜잭션 안에서만 수행하고 ROLLBACK 한다
 *   5. authenticated 세션에서 자기 승격이 여전히 막히는지
 *
 * 이메일 등 식별 정보는 출력하지 않는다.
 *
 * 의존성: npm install --no-save pg
 */
import { connect } from "./db-connect.mjs";

const c = await connect();
const out = (label, v) =>
  console.log(`\n[${label}]`, typeof v === "string" ? v : JSON.stringify(v));

// 1) 함수 권한 — service_role 만 EXECUTE
const { rows: acl } = await c.query(`
  SELECT p.proname, p.prosecdef AS security_definer, p.proacl::text AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='bootstrap_super_admin'`);
out("function acl", acl);

for (const role of ["anon", "authenticated", "service_role", "public"]) {
  const { rows } = await c.query(
    `SELECT has_function_privilege($1, 'public.bootstrap_super_admin(uuid,text)', 'EXECUTE') AS can_execute`,
    [role]
  );
  console.log(`  execute[${role}] = ${rows[0].can_execute}`);
}

// 2) 트리거 예외 플래그가 반영되었는지
const { rows: trg } = await c.query(`
  SELECT pg_get_functiondef(p.oid) LIKE '%app.super_admin_bootstrap%' AS has_flag
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='enforce_profile_role_immutable'`);
out("trigger fn has bootstrap flag", trg);

// 3) UUID 와 이메일이 맞지 않는 조합은 거절되어야 한다
try {
  await c.query(`SELECT public.bootstrap_super_admin($1, $2)`, [
    "00000000-0000-0000-0000-000000000000",
    "attacker@evil.test",
  ]);
  out("mismatch test", "FAIL - 거절되지 않았다");
} catch (e) {
  out("mismatch test", `OK - 거절됨: ${e.message}`);
}

try {
  await c.query(`SELECT public.bootstrap_super_admin(NULL, NULL)`);
  out("null test", "FAIL");
} catch (e) {
  out("null test", `OK - 거절됨: ${e.message}`);
}

// 4) 실제 계정으로 승격 경로 전체를 검증하고 ROLLBACK (영구 변경 없음)
const { rows: users } = await c.query(`
  SELECT u.id, u.email, p.role, p.is_supplier, p.is_verified
    FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id
   WHERE u.email IS NOT NULL
   ORDER BY u.created_at LIMIT 1`);

if (users.length === 0) {
  out("promotion dry-run", "auth.users 에 이메일 보유 계정이 없어 건너뜀");
} else {
  const u = users[0];
  console.log(
    `\n[promotion dry-run] 대상 role=${u.role} is_supplier=${u.is_supplier} is_verified=${u.is_verified}`
  );

  await c.query("BEGIN");
  try {
    const { rows: r1 } = await c.query(`SELECT public.bootstrap_super_admin($1,$2) AS r`, [u.id, u.email]);
    console.log("  1차 호출 promoted =", r1[0].r.promoted, "role =", r1[0].r.role);

    const { rows: r2 } = await c.query(`SELECT public.bootstrap_super_admin($1,$2) AS r`, [
      u.id,
      `  ${u.email.toUpperCase()} `,
    ]);
    console.log("  2차 호출(멱등/대소문자) promoted =", r2[0].r.promoted, "role =", r2[0].r.role);

    const { rows: after } = await c.query(
      `SELECT role, is_supplier, is_verified, verified_at IS NOT NULL AS has_verified_at, verified_by
         FROM public.profiles WHERE id=$1`,
      [u.id]
    );
    console.log("  승격 후 profiles:", JSON.stringify(after[0]));

    try {
      await c.query(`SELECT public.bootstrap_super_admin($1,$2)`, [
        "11111111-1111-1111-1111-111111111111",
        u.email,
      ]);
      console.log("  교차 승격 시도: FAIL - 거절되지 않았다");
    } catch (e) {
      console.log(`  교차 승격 시도: OK - 거절됨 (${e.message})`);
    }
  } finally {
    await c.query("ROLLBACK");
  }

  const { rows: restored } = await c.query(`SELECT role FROM public.profiles WHERE id=$1`, [u.id]);
  console.log("  ROLLBACK 후 role:", restored[0]?.role);
}

// 5) authenticated 세션(브라우저 경로)에서 자기 승격이 여전히 막히는지
await c.query("BEGIN");
try {
  const { rows: u } = await c.query(`SELECT id FROM public.profiles WHERE role <> 'super_admin' LIMIT 1`);

  if (u.length) {
    await c.query(`SET LOCAL ROLE authenticated`);
    await c.query(
      `SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role','authenticated')::text, true)`,
      [u[0].id]
    );

    try {
      await c.query(`UPDATE public.profiles SET role='super_admin' WHERE id=$1`, [u[0].id]);
      out("self-promotion via UPDATE", "FAIL - 막히지 않았다");
    } catch (e) {
      out("self-promotion via UPDATE", `OK - 차단됨: ${e.message}`);
    }
  }
} finally {
  await c.query("ROLLBACK");
}

await c.query("BEGIN");
try {
  const { rows: u } = await c.query(`SELECT id FROM public.profiles WHERE role <> 'super_admin' LIMIT 1`);

  if (u.length) {
    await c.query(`SET LOCAL ROLE authenticated`);
    try {
      await c.query(`SELECT public.bootstrap_super_admin($1,$2)`, [u[0].id, "x@y.test"]);
      out("self-promotion via RPC", "FAIL - 호출이 허용됐다");
    } catch (e) {
      out("self-promotion via RPC", `OK - 차단됨: ${e.message}`);
    }
  }
} finally {
  await c.query("ROLLBACK");
}

await c.end();
