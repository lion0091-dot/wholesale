/**
 * 적용 결과 기능 검증 (일회성 도구).
 *
 * 모든 테스트는 하나의 트랜잭션 안에서 실행한 뒤 ROLLBACK 하므로
 * 실제 데이터(auth.users / profiles / wholesalers ...)는 남지 않는다.
 */
import { connect } from "./db-connect.mjs";

const client = await connect();

const SUPPLIER_UID = "11111111-1111-4111-8111-111111111111";
const BUYER_UID = "22222222-2222-4222-8222-222222222222";
const ADMIN_UID = "33333333-3333-4333-8333-333333333333";

/** auth.uid() 가 읽는 세션 클레임을 흉내낸다. */
async function actAs(uid) {
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: uid, role: "authenticated" }),
  ]);
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid]);
}

/** 실패해야 하는 쿼리를 세이브포인트로 감싸 실행한다. */
async function expectFailure(label, sql, params = []) {
  await client.query(`SAVEPOINT sp_expect`);

  try {
    await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT sp_expect`);
    throw new Error(`${label}: 차단되지 않았다`);
  } catch (error) {
    if (error.message.includes("차단되지 않았다")) {
      throw error;
    }

    await client.query(`ROLLBACK TO SAVEPOINT sp_expect`);
    return error.message.split("\n")[0];
  }
}

const results = [];

function record(label, detail) {
  results.push(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function createAuthUser(uid, email, name) {
  await client.query(
    `INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             $2, jsonb_build_object('name', $3::text), now(), now())`,
    [uid, email, name]
  );
}

try {
  await client.query("BEGIN");

  // ------------------------------------------------------------------
  // 0) 스키마 확인
  // ------------------------------------------------------------------
  const { rows: columns } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='profiles'
        AND column_name IN ('is_supplier','is_verified','terms_agreed_at','privacy_agreed_at','marketing_agreed_at','verified_at','verified_by')`
  );
  record("profiles 플래그 컬럼", `${columns.length}/7`);

  const { rows: nullable } = await client.query(
    `SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND column_name='business_number'
        AND table_name IN ('wholesalers','organizations') ORDER BY table_name`
  );
  record("business_number NULL 허용", JSON.stringify(nullable));

  const { rows: triggers } = await client.query(
    `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='auth' AND c.relname='users' AND NOT t.tgisinternal`
  );
  record("auth.users 트리거", JSON.stringify(triggers.map((row) => row.tgname)));

  const { rows: functions } = await client.query(
    `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND proname IN
        ('handle_new_user','complete_supplier_signup','submit_supplier_business_number',
         'set_supplier_verification','claim_shop_access','get_public_shop_identity',
         'enforce_profile_role_immutable') ORDER BY proname`
  );
  record("생성된 함수", JSON.stringify(functions.map((row) => row.proname)));

  // ------------------------------------------------------------------
  // 1) 카카오 가입 직후 profiles 기본 레코드 자동 생성
  // ------------------------------------------------------------------
  await createAuthUser(SUPPLIER_UID, "supplier-test@example.com", "김태양");

  const { rows: created } = await client.query(
    `SELECT role, name, is_supplier, is_verified, terms_agreed_at FROM public.profiles WHERE id=$1`,
    [SUPPLIER_UID]
  );

  if (
    created.length !== 1 ||
    created[0].is_supplier !== true ||
    created[0].is_verified !== false ||
    created[0].role !== "wholesaler" ||
    created[0].terms_agreed_at !== null
  ) {
    throw new Error(`트리거 기본 레코드 불일치: ${JSON.stringify(created)}`);
  }
  record("트리거 자동 생성(is_supplier/is_verified)", JSON.stringify(created[0]));

  // ------------------------------------------------------------------
  // 2) 최소 정보 제출 → 즉시 사용 가능 상태
  // ------------------------------------------------------------------
  await actAs(SUPPLIER_UID);

  const { rows: signup } = await client.query(
    `SELECT public.complete_supplier_signup('마장동 태양축산', '김태양', '010-1234-5678', NULL, true) AS result`
  );
  const signupResult = signup[0].result;

  if (!signupResult.wholesaler_id || !signupResult.organization_id || signupResult.is_verified !== false) {
    throw new Error(`가입 결과 불일치: ${JSON.stringify(signupResult)}`);
  }
  record("complete_supplier_signup", JSON.stringify(signupResult));

  const { rows: afterSignup } = await client.query(
    `SELECT p.is_supplier, p.is_verified, p.terms_agreed_at IS NOT NULL AS agreed,
            p.marketing_agreed_at IS NOT NULL AS marketing,
            (SELECT count(*) FROM public.wholesalers w WHERE w.profile_id=p.id) AS wholesalers,
            (SELECT count(*) FROM public.organization_staff s WHERE s.user_id=p.id AND s.role='owner') AS owner_rows
       FROM public.profiles p WHERE p.id=$1`,
    [SUPPLIER_UID]
  );
  record("가입 후 상태", JSON.stringify(afterSignup[0]));

  // ------------------------------------------------------------------
  // 3) 승인 플래그 / 역할 자기 승격 차단
  // ------------------------------------------------------------------
  record(
    "is_verified 자기 승격 차단",
    await expectFailure("is_verified", `UPDATE public.profiles SET is_verified = true WHERE id=$1`, [
      SUPPLIER_UID,
    ])
  );

  record(
    "role 자기 변경 차단",
    await expectFailure("role", `UPDATE public.profiles SET role = 'super_admin' WHERE id=$1`, [
      SUPPLIER_UID,
    ])
  );

  record(
    "set_supplier_verification 슈퍼관리자 전용",
    await expectFailure(
      "set_supplier_verification",
      `SELECT public.set_supplier_verification($1::uuid, true)`,
      [signupResult.wholesaler_id]
    )
  );

  // ------------------------------------------------------------------
  // 4) 사업자등록번호 제출 → 승인 → 초대장 발부 권한
  // ------------------------------------------------------------------
  const { rows: submitted } = await client.query(
    `SELECT public.submit_supplier_business_number('220-81-62517') AS result`
  );
  record("submit_supplier_business_number", JSON.stringify(submitted[0].result));

  // 슈퍼관리자 승인 시뮬레이션 — 별도 관리자 계정을 만들어 그 세션으로 승인한다.
  // (role 변경은 앱에서 차단되므로, 테스트 하네스는 postgres 권한으로 우회 플래그를 직접 세운다)
  await createAuthUser(ADMIN_UID, "admin-test@example.com", "운영자");
  await client.query(`SELECT set_config('app.supplier_onboarding', 'on', true)`);
  await client.query(`UPDATE public.profiles SET role='super_admin', is_supplier=false WHERE id=$1`, [
    ADMIN_UID,
  ]);
  await client.query(`SELECT set_config('app.supplier_onboarding', 'off', true)`);

  await actAs(ADMIN_UID);
  const { rows: verified } = await client.query(
    `SELECT public.set_supplier_verification($1::uuid, true) AS result`,
    [signupResult.wholesaler_id]
  );
  record("set_supplier_verification(승인)", JSON.stringify(verified[0].result));

  await actAs(SUPPLIER_UID);

  const { rows: verifiedState } = await client.query(
    `SELECT is_verified, verified_at IS NOT NULL AS stamped FROM public.profiles WHERE id=$1`,
    [SUPPLIER_UID]
  );
  record("승인 후 플래그", JSON.stringify(verifiedState[0]));

  // ------------------------------------------------------------------
  // 5) 바이어 경로 — 초대 링크로 들어온 신규 계정의 바이어 전환
  // ------------------------------------------------------------------
  // 승인 시 업체 상태도 active 가 된다 (관리자 콘솔의 승인 액션과 동일한 효과)
  await actAs(ADMIN_UID);
  await client.query(`UPDATE public.wholesalers SET status='active' WHERE id=$1`, [
    signupResult.wholesaler_id,
  ]);

  const { rows: tokenRow } = await client.query(
    `SELECT shop_token FROM public.wholesalers WHERE id=$1`,
    [signupResult.wholesaler_id]
  );
  const shopToken = tokenRow[0].shop_token;

  await createAuthUser(BUYER_UID, "buyer-test@example.com", "박사장");
  await actAs(BUYER_UID);

  const { rows: claim } = await client.query(`SELECT public.claim_shop_access($1::uuid) AS result`, [
    shopToken,
  ]);
  record("claim_shop_access(신규 바이어)", JSON.stringify(claim[0].result));

  const { rows: buyerState } = await client.query(
    `SELECT role, is_supplier, is_verified,
            (SELECT count(*) FROM public.retailers r WHERE r.profile_id=$1) AS retailers,
            (SELECT count(*) FROM public.wholesaler_retailers wr
              WHERE wr.retailer_id=(SELECT id FROM public.retailers WHERE profile_id=$1)
                AND wr.status='active') AS active_links
       FROM public.profiles WHERE id=$1`,
    [BUYER_UID]
  );

  if (buyerState[0].role !== "retailer" || buyerState[0].is_supplier !== false) {
    throw new Error(`바이어 전환 실패: ${JSON.stringify(buyerState[0])}`);
  }
  record("바이어 전환 결과", JSON.stringify(buyerState[0]));

  // 가입을 마친 공급사 계정은 바이어로 전환되지 않아야 한다.
  await actAs(SUPPLIER_UID);
  record(
    "가입 완료 공급사의 바이어 전환 차단",
    await expectFailure("claim_shop_access", `SELECT public.claim_shop_access($1::uuid)`, [shopToken])
  );

  // ------------------------------------------------------------------
  // 6) 로그인 게이트 공개 조회
  // ------------------------------------------------------------------
  const { rows: identity } = await client.query(
    `SELECT * FROM public.get_public_shop_identity($1::uuid)`,
    [shopToken]
  );
  record("get_public_shop_identity", JSON.stringify(identity));
} catch (error) {
  console.log(results.join("\n"));
  console.error("\n✗ 검증 실패:", error.message);
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
  process.exit(1);
}

await client.query("ROLLBACK");
await client.end();

console.log(results.join("\n"));
console.log("\n검증 완료 (모든 테스트 데이터는 ROLLBACK 되었습니다)");
