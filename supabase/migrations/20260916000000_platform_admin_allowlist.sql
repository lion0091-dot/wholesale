-- ====================================================================
-- 플랫폼 관리자 allowlist — 환경변수 1명 → DB 테이블 기반 다중 관리자
--
-- 문제:
--   슈퍼관리자 승격 트리거가 SUPER_ADMIN_EMAIL 환경변수 1개뿐이라
--   직원 여러 명에게 권한을 줄 방법이 없었다. 또한 회수 경로가 아예 없어
--   한 번 승격된 계정은 Supabase 콘솔에서 직접 UPDATE 하는 수동 절차로만
--   되돌릴 수 있었다.
--
-- 해결:
--   "누가 관리자가 될 수 있는가"의 근거를 이 테이블로 옮긴다.
--   "누가 관리자인가"의 근거는 이전과 동일하게 DB(profiles.role) 하나다.
--   모든 RLS 정책(get_current_role() = 'super_admin')은 그대로 유효하다.
--
-- 신뢰 경계 — env 방식과 달라지는 지점:
--   env 의 경계는 "배포 설정을 만질 수 있는 사람"이었다. 테이블의 경계는
--   "이미 관리자인 사람"이므로 자기 확장 체인이 되고, 뿌리(root of trust)가
--   따로 필요하다. 그래서 SUPER_ADMIN_EMAIL 을 제거하지 않고 비상용 루트로
--   남긴다. 평시 부여는 테이블, 락아웃 복구는 환경변수.
--   두 경로는 반환값의 source 로 구분되어 감사에 남는다.
--
-- 2단 권한:
--   can_grant = false → 승인/구독 등 거버넌스 업무만 (직원 대다수)
--   can_grant = true  → 관리자 명단 편집까지 (운영 책임자)
--   profiles.role 은 둘 다 'super_admin' 이다. RLS 정책 10여 곳이 모두
--   = 'super_admin' 을 비교하므로, 등급을 role 로 쪼개면 정책 전면 수정이
--   필요하다. 부여 권한만 이 컬럼으로 분리해 그 비용을 피한다.
--
-- 이메일 선등록(가입 전 명단 등록)은 이번 범위에서 제외했다.
-- 따라서 등록 대상은 "이미 한 번 로그인한 계정"이며, 키는 user_id 하나다.
-- 카카오 이메일 미동의 계정도 이 경로로는 정상 승격된다.
--
-- 이 마이그레이션은 전체가 멱등(idempotent)하므로 재실행해도 안전하다.
-- ====================================================================

-- ====================================================================
-- 1. ALLOWLIST 테이블
--
--    revoked_at 기반 소프트 삭제를 쓰는 이유:
--      DELETE 로 지우면 "누가 언제 누구의 권한을 뺏었는가"가 사라진다.
--      별도 감사 로그 테이블을 만드는 대신 행을 남겨 이력을 보존한다.
--      활성 항목의 유일성은 부분 유니크 인덱스로 보장한다.
-- ====================================================================
CREATE TABLE IF NOT EXISTS public.platform_admin_allowlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- auth.users 직접 참조 (organization_staff 와 동일 규약).
    -- 계정이 삭제되면 명단 항목도 함께 사라져야 한다.
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- 관리자 명단 편집 권한 (2단 권한의 상위 등급)
    can_grant BOOLEAN NOT NULL DEFAULT false,
    -- 부여 경로. 사람이 부여한 권한과 자동 부트스트랩을 감사에서 구분한다.
    source TEXT NOT NULL DEFAULT 'admin_grant'
        CHECK (source IN ('admin_grant', 'env_root', 'migration_backfill')),
    note TEXT,
    granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 회수자만 있고 회수 시각이 없는 모순 상태를 막는다.
    CONSTRAINT platform_admin_allowlist_revoked_consistent
        CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

COMMENT ON TABLE public.platform_admin_allowlist IS
    '플랫폼 슈퍼관리자 허용 명단. "관리자가 될 수 있는가"의 근거이며, "관리자인가"의 근거는 profiles.role 이다.';
COMMENT ON COLUMN public.platform_admin_allowlist.can_grant IS
    '관리자 명단 편집 권한. false 인 관리자는 거버넌스 업무만 수행한다.';
COMMENT ON COLUMN public.platform_admin_allowlist.revoked_at IS
    'NULL 이면 활성. 회수는 이 값을 채우고 profiles.role 강등까지 한 트랜잭션에서 처리한다.';

-- 한 계정의 활성 항목은 최대 1개. 회수된 과거 이력은 제한 없이 쌓인다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_admin_allowlist_active
    ON public.platform_admin_allowlist(user_id)
    WHERE revoked_at IS NULL;

-- 명단 화면(최신순) 및 "마지막 can_grant 관리자" 검사용
CREATE INDEX IF NOT EXISTS idx_platform_admin_allowlist_active
    ON public.platform_admin_allowlist(can_grant, created_at DESC)
    WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS trg_platform_admin_allowlist_updated_at
    ON public.platform_admin_allowlist;

CREATE TRIGGER trg_platform_admin_allowlist_updated_at
    BEFORE UPDATE ON public.platform_admin_allowlist
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ====================================================================
-- 2. RLS — 읽기는 슈퍼관리자, 쓰기는 아무에게도 열지 않는다
--
--    쓰기 정책을 만들지 않는 이유:
--      can_grant 가 의미를 가지려면 "관리자라고 해서 이 테이블을 직접
--      UPDATE 할 수는 없다"가 성립해야 한다. 슈퍼관리자 전체에 쓰기를
--      열면 can_grant = false 계정이 자기 행을 true 로 바꿔 등급 분리가
--      무의미해진다. 모든 변경은 4~5번의 SECURITY DEFINER RPC 만 통한다.
--
--    읽기를 슈퍼관리자에게 여는 이유:
--      명단 화면이 사용자 세션으로 직접 조회할 수 있어야 한다.
--      민감한 것은 "명단을 아는 것"이 아니라 "명단을 바꾸는 것"이다.
-- ====================================================================
ALTER TABLE public.platform_admin_allowlist ENABLE ROW LEVEL SECURITY;

-- Supabase 기본 권한(public 스키마 신규 테이블에 anon/authenticated ALL)을
-- 신뢰하지 않고 이 테이블에 대해서만 명시적으로 좁힌다.
REVOKE ALL ON TABLE public.platform_admin_allowlist FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE public.platform_admin_allowlist FROM anon;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.platform_admin_allowlist FROM authenticated;
        GRANT SELECT ON TABLE public.platform_admin_allowlist TO authenticated;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT ALL ON TABLE public.platform_admin_allowlist TO service_role;
    END IF;
END;
$$;

DROP POLICY IF EXISTS "Admin allowlist viewable by super admin"
    ON public.platform_admin_allowlist;

CREATE POLICY "Admin allowlist viewable by super admin"
    ON public.platform_admin_allowlist
    FOR SELECT USING (public.get_current_role() = 'super_admin');

-- ====================================================================
-- 3. 세션 판정 헬퍼 (boolean 만 반환 — 명단 열거 불가)
--
--    미들웨어(Edge)는 아직 승격되지 않은 사용자 세션으로 동작하므로
--    이 테이블을 직접 SELECT 할 수 없다(RLS 가 막는다). 그렇다고 정책을
--    authenticated 로 열면 전 로그인 사용자에게 명단이 노출된다.
--    get_current_role() 과 같은 패턴으로, 자기 자신에 대한 판정 결과만
--    불리언으로 돌려주는 함수를 경유한다.
-- ====================================================================

-- 현재 세션이 관리자 명단에 있는가 (승격 전 /admin 통과 판정용)
CREATE OR REPLACE FUNCTION public.is_self_admin_eligible()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.platform_admin_allowlist a
         WHERE a.user_id = auth.uid()
           AND a.revoked_at IS NULL
    );
$$;

COMMENT ON FUNCTION public.is_self_admin_eligible() IS
    '현재 세션 계정의 관리자 명단 등재 여부. 행을 노출하지 않으므로 authenticated 에 열어도 명단 열거가 불가능하다.';

-- 현재 세션이 명단을 편집할 수 있는가 (UI 조건부 렌더링 / 액션 가드용)
CREATE OR REPLACE FUNCTION public.can_current_user_grant_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.platform_admin_allowlist a
          JOIN public.profiles p ON p.id = a.user_id
         WHERE a.user_id = auth.uid()
           AND a.revoked_at IS NULL
           AND a.can_grant = true
           AND p.role = 'super_admin'
    );
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT EXECUTE ON FUNCTION public.is_self_admin_eligible() TO authenticated;
        GRANT EXECUTE ON FUNCTION public.can_current_user_grant_admin() TO authenticated;
    END IF;
END;
$$;

-- ====================================================================
-- 4. 권한 플래그 자기 승격 차단 트리거 — 회수 전용 예외 추가
--
--    회수는 profiles.role 을 낮추는 쓰기이므로 이 트리거를 통과해야 한다.
--    service_role 컨텍스트에서는 auth.uid() 가 NULL 이라
--    get_current_role() = 'super_admin' 예외에 걸리지 않는다.
--
--    승격용 app.super_admin_bootstrap 을 재사용하지 않고 플래그를 분리하는
--    이유는 기존 마이그레이션과 동일하다 — 장애 분석 때 어떤 경로가 role 을
--    바꿨는지 구분할 수 있어야 한다.
--
--    CREATE OR REPLACE FUNCTION 은 기존 트리거 바인딩을 유지하므로
--    트리거를 다시 만들지 않는다. (기존 함수 본문에서 추가된 것은 한 줄뿐)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_role_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_privileged BOOLEAN;
BEGIN
    v_privileged :=
        COALESCE(current_setting('app.supplier_onboarding', true), '') = 'on'
        OR COALESCE(current_setting('app.super_admin_bootstrap', true), '') = 'on'
        OR COALESCE(current_setting('app.platform_admin_revoke', true), '') = 'on'
        OR public.get_current_role() = 'super_admin';

    IF v_privileged THEN
        RETURN NEW;
    END IF;

    IF NEW.role <> OLD.role THEN
        RAISE EXCEPTION '역할(role)은 스스로 변경할 수 없습니다.';
    END IF;

    IF NEW.is_supplier <> OLD.is_supplier OR NEW.is_verified <> OLD.is_verified THEN
        RAISE EXCEPTION '승인 상태는 스스로 변경할 수 없습니다.';
    END IF;

    RETURN NEW;
END;
$$;

-- ====================================================================
-- 5. 승격 (service_role 전용) — bootstrap_super_admin 의 일반화
--
--    자격 판정을 전부 DB 안에서 한다. 앱은 "미승격이면 호출" 한 줄만 남는다.
--
--    판정 우선순위:
--      1) allowlist 활성 항목 보유        → source = 'allowlist'
--      2) p_bootstrap_email == 실제 이메일 → source = 'env_root'
--                                            (+ 명단에 can_grant=true 자동 등재)
--      해당 없음                          → promoted=false, source='not_eligible'
--
--    not_eligible 을 EXCEPTION 으로 올리지 않는 이유:
--      명단 방식에서는 "자격 없음"이 압도적 다수 경로(모든 일반 로그인)다.
--      기존 SUPER_ADMIN_EMAIL_MISMATCH 처럼 예외로 터뜨리면 정상 흐름이
--      에러 로그를 채우고, 진짜 오류와 구분되지 않는다.
--
--    p_bootstrap_email 을 호출자가 넘기는 것이 안전한 이유:
--      이 함수는 service_role 전용이고, 넘어온 이메일을 근거로 쓰지 않고
--      auth.users 의 실제 이메일과 일치하는지 DB 안에서 재확인한다.
--      즉 신뢰 경계는 기존 구조(service_role 키 + 서버 환경변수)와 같다.
--
--    예외:
--      PLATFORM_ADMIN_INVALID_INPUT    인수 누락
--      PLATFORM_ADMIN_USER_NOT_FOUND   auth.users 에 없는 UUID
-- ====================================================================
CREATE OR REPLACE FUNCTION public.promote_platform_admin(
    p_user_id         UUID,
    p_bootstrap_email TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now         TIMESTAMPTZ := now();
    v_boot_email  TEXT := NULLIF(lower(btrim(COALESCE(p_bootstrap_email, ''))), '');
    v_email       TEXT;
    v_name        TEXT;
    v_role        TEXT;
    v_source      TEXT;
    v_can_grant   BOOLEAN := false;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'PLATFORM_ADMIN_INVALID_INPUT';
    END IF;

    -- 5-1. 신원 확인. 카카오 이메일 미동의 계정은 v_email 이 NULL 이며,
    --      명단(user_id) 경로에는 아무 영향이 없다.
    SELECT lower(btrim(u.email)),
           COALESCE(
               NULLIF(u.raw_user_meta_data ->> 'name', ''),
               NULLIF(u.raw_user_meta_data ->> 'full_name', ''),
               NULLIF(u.raw_user_meta_data ->> 'preferred_username', ''),
               '플랫폼 관리자'
           )
      INTO v_email, v_name
      FROM auth.users u
     WHERE u.id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PLATFORM_ADMIN_USER_NOT_FOUND';
    END IF;

    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_user_id;

    -- 5-2. 자격 판정 (1) 명단
    SELECT a.can_grant INTO v_can_grant
      FROM public.platform_admin_allowlist a
     WHERE a.user_id = p_user_id
       AND a.revoked_at IS NULL;

    IF FOUND THEN
        v_source := 'allowlist';

    -- 5-3. 자격 판정 (2) 환경변수 비상용 루트.
    --      락아웃 복구 경로이므로 항상 can_grant = true 로 등재한다.
    ELSIF v_boot_email IS NOT NULL AND v_email IS NOT NULL AND v_email = v_boot_email THEN
        v_source := 'env_root';
        v_can_grant := true;

        INSERT INTO public.platform_admin_allowlist (user_id, can_grant, source, note)
        VALUES (p_user_id, true, 'env_root', 'SUPER_ADMIN_EMAIL 비상용 루트 자동 등재')
        ON CONFLICT (user_id) WHERE revoked_at IS NULL
        DO UPDATE SET can_grant = true,
                      updated_at = v_now;

    ELSE
        -- 명단에 없지만 이미 super_admin 인 경우(콘솔 수동 UPDATE 등)에도
        -- 강등하지 않는다. 이 함수는 승격만 담당하고, 강등은 6번의 명시적
        -- 회수로만 일어난다. profiles.role 이 계속 판정 근거이므로 앱 동작은
        -- 이전과 동일하다.
        RETURN jsonb_build_object(
            'user_id', p_user_id,
            'email', v_email,
            'role', COALESCE(v_role, ''),
            'promoted', false,
            'source', 'not_eligible',
            'can_grant', false,
            'is_super_admin', v_role = 'super_admin'
        );
    END IF;

    -- 5-4. 멱등 — 로그인마다 호출되므로 이미 슈퍼관리자면 아무것도 쓰지 않는다.
    IF v_role = 'super_admin' THEN
        RETURN jsonb_build_object(
            'user_id', p_user_id,
            'email', v_email,
            'role', v_role,
            'promoted', false,
            'source', v_source,
            'can_grant', v_can_grant,
            'is_super_admin', true
        );
    END IF;

    PERFORM set_config('app.super_admin_bootstrap', 'on', true);

    IF v_role IS NULL THEN
        -- 트리거(handle_new_user)보다 이 경로가 먼저 도달하는 경우는 없지만,
        -- 프로필이 없더라도 승격이 실패하지 않게 한다.
        INSERT INTO public.profiles (
            id, role, name, phone, is_supplier, is_verified,
            terms_agreed_at, privacy_agreed_at
        )
        VALUES (p_user_id, 'super_admin', v_name, '', false, true, v_now, v_now)
        ON CONFLICT (id) DO UPDATE
           SET role = 'super_admin',
               is_verified = true,
               updated_at = v_now;
    ELSE
        UPDATE public.profiles p
           SET role = 'super_admin',
               -- 관리자 계정이 공급사 온보딩까지 마친 상태(개발/시연 겸용)라면
               -- 공급사 기능을 잃지 않도록 업체 레코드 보유 여부를 그대로 따른다.
               is_supplier = EXISTS (
                   SELECT 1 FROM public.wholesalers w WHERE w.profile_id = p_user_id
               ),
               -- 관리자는 행정 승인 심사 대상이 아니다.
               is_verified = true,
               verified_at = COALESCE(p.verified_at, v_now),
               -- verified_by 는 비워 둔다. 사람이 심사한 공급사 승인과
               -- 관리자 승격을 감사 기록에서 구분하기 위한 의도적 NULL 이다.
               updated_at = v_now
         WHERE p.id = p_user_id;
    END IF;

    -- 권한 우회 창을 profiles 쓰기 한 문장으로 제한한다.
    PERFORM set_config('app.super_admin_bootstrap', 'off', true);

    RETURN jsonb_build_object(
        'user_id', p_user_id,
        'email', v_email,
        'role', 'super_admin',
        'promoted', true,
        'source', v_source,
        'can_grant', v_can_grant,
        'is_super_admin', true
    );
END;
$$;

COMMENT ON FUNCTION public.promote_platform_admin(UUID, TEXT) IS
    '명단 등재 계정 또는 SUPER_ADMIN_EMAIL 루트 계정을 슈퍼관리자로 승격한다. 멱등. service_role 전용.';

-- ====================================================================
-- 6. 명단 부여 (service_role 전용)
--
--    명단 등재와 실제 승격을 한 트랜잭션에서 처리한다. 등재만 하고
--    대상자의 재로그인을 기다리게 하면 "부여했는데 안 된다"가 되고,
--    그 사이 명단과 profiles.role 이 어긋난 창이 생긴다.
--
--    p_actor_id 를 인수로 받는 이유:
--      service_role 컨텍스트에서는 auth.uid() 가 NULL 이라 DB 안에서
--      행위자를 알 수 없다. 앱이 세션에서 읽어 넘기고, DB 는 그 계정이
--      실제로 can_grant 권한을 가졌는지 다시 검증한다.
--
--    예외:
--      PLATFORM_ADMIN_INVALID_INPUT     인수 누락
--      PLATFORM_ADMIN_GRANT_FORBIDDEN   행위자에게 명단 편집 권한 없음
--      PLATFORM_ADMIN_USER_NOT_FOUND    대상이 auth.users 에 없음
--                                       (= 아직 로그인한 적 없는 계정)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.grant_platform_admin(
    p_user_id   UUID,
    p_actor_id  UUID,
    p_can_grant BOOLEAN DEFAULT false,
    p_note      TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
    IF p_user_id IS NULL OR p_actor_id IS NULL THEN
        RAISE EXCEPTION 'PLATFORM_ADMIN_INVALID_INPUT';
    END IF;

    -- 6-1. 행위자 검증 — 명단의 can_grant 와 profiles.role 을 모두 본다.
    --      (명단에는 남아 있지만 강등된 계정이 부여를 계속하지 못하게)
    IF NOT EXISTS (
        SELECT 1
          FROM public.platform_admin_allowlist a
          JOIN public.profiles p ON p.id = a.user_id
         WHERE a.user_id = p_actor_id
           AND a.revoked_at IS NULL
           AND a.can_grant = true
           AND p.role = 'super_admin'
    ) THEN
        RAISE EXCEPTION 'PLATFORM_ADMIN_GRANT_FORBIDDEN';
    END IF;

    -- 6-2. 이메일 선등록을 지원하지 않으므로, 대상은 반드시 기존 계정이다.
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
        RAISE EXCEPTION 'PLATFORM_ADMIN_USER_NOT_FOUND';
    END IF;

    -- 회수된 과거 항목은 부분 유니크 인덱스 대상이 아니므로, 재부여는
    -- 충돌 없이 새 활성 행을 만든다(이력 보존). 활성 항목이 이미 있으면
    -- 등급/메모만 갱신한다.
    INSERT INTO public.platform_admin_allowlist AS a (
        user_id, can_grant, source, note, granted_by
    )
    VALUES (p_user_id, COALESCE(p_can_grant, false), 'admin_grant', v_note, p_actor_id)
    ON CONFLICT (user_id) WHERE revoked_at IS NULL
    DO UPDATE SET can_grant  = EXCLUDED.can_grant,
                  note       = COALESCE(EXCLUDED.note, a.note),
                  granted_by = EXCLUDED.granted_by,
                  updated_at = now();

    -- 6-3. 같은 트랜잭션에서 승격까지 확정. 명단 항목이 방금 생겼으므로
    --      promote 는 source='allowlist' 경로로 들어간다.
    RETURN public.promote_platform_admin(p_user_id)
           || jsonb_build_object('granted_by', p_actor_id);
END;
$$;

COMMENT ON FUNCTION public.grant_platform_admin(UUID, UUID, BOOLEAN, TEXT) IS
    '대상 계정을 관리자 명단에 등재하고 같은 트랜잭션에서 승격한다. can_grant 보유자만 호출 가능. service_role 전용.';

-- ====================================================================
-- 7. 명단 회수 (service_role 전용)
--
--    ⚠ 순서와 원자성이 둘 다 필요하다:
--      · 명단만 지우면 profiles.role 이 남아 여전히 관리자다.
--      · role 만 낮추면 다음 로그인에서 명단이 다시 승격시킨다.
--    그래서 명단 무효화 → 강등을 한 함수 안에서 처리한다.
--
--    강등 목적지는 공급사 업체(wholesalers) 레코드 보유 여부로 정한다.
--      보유    → 'wholesaler'. is_verified 는 실제 승인 증거(업체 status)로
--                되돌린다. 승격 때 무조건 true 로 올렸던 값을 그대로 두면
--                심사도 없이 정회원 공급사가 된다.
--      미보유  → 'retailer'. claim_shop_access 의 바이어 전환과 같은 값.
--
--    락아웃 가드 2개:
--      · 행위자 can_grant 검증 (6-1과 동일)
--      · 자기 자신 회수 금지
--
--    "마지막 can_grant 관리자가 사라지는" 상황은 별도 검사가 필요 없다.
--    회수자는 항상 can_grant 보유자이고 자기 자신은 회수할 수 없으므로,
--    어떤 회수가 성공하든 회수자 자신이 활성 편집자로 남는다.
--    (관리자 전원이 잠기는 경우는 명단 밖에서 profiles 를 직접 건드렸을 때뿐이고,
--     그 복구 경로가 SUPER_ADMIN_EMAIL 비상용 루트다)
--
--    예외:
--      PLATFORM_ADMIN_INVALID_INPUT     인수 누락
--      PLATFORM_ADMIN_SELF_REVOKE       자기 자신 회수 시도
--      PLATFORM_ADMIN_GRANT_FORBIDDEN   행위자에게 명단 편집 권한 없음
--      PLATFORM_ADMIN_NOT_ALLOWLISTED   대상에게 활성 명단 항목이 없음
-- ====================================================================
CREATE OR REPLACE FUNCTION public.revoke_platform_admin(
    p_user_id  UUID,
    p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now            TIMESTAMPTZ := now();
    v_role           TEXT;
    v_has_wholesaler BOOLEAN;
    v_is_verified    BOOLEAN;
    v_new_role       TEXT;
BEGIN
    IF p_user_id IS NULL OR p_actor_id IS NULL THEN
        RAISE EXCEPTION 'PLATFORM_ADMIN_INVALID_INPUT';
    END IF;

    -- 7-1. 자기 자신 회수 금지 — 유일한 관리자가 스스로 잠기는 사고를 막는다.
    IF p_user_id = p_actor_id THEN
        RAISE EXCEPTION 'PLATFORM_ADMIN_SELF_REVOKE';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.platform_admin_allowlist a
          JOIN public.profiles p ON p.id = a.user_id
         WHERE a.user_id = p_actor_id
           AND a.revoked_at IS NULL
           AND a.can_grant = true
           AND p.role = 'super_admin'
    ) THEN
        RAISE EXCEPTION 'PLATFORM_ADMIN_GRANT_FORBIDDEN';
    END IF;

    -- 7-2. 대상의 활성 항목을 잠근다. 같은 대상에 대한 동시 회수가
    --      이중 강등을 일으키지 않도록 FOR UPDATE 로 직렬화한다.
    PERFORM 1
       FROM public.platform_admin_allowlist a
      WHERE a.user_id = p_user_id
        AND a.revoked_at IS NULL
        FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PLATFORM_ADMIN_NOT_ALLOWLISTED';
    END IF;

    -- 7-3. 명단 먼저 무효화. 이 순서여야 재승격 루프가 생기지 않는다.
    UPDATE public.platform_admin_allowlist a
       SET revoked_at = v_now,
           revoked_by = p_actor_id,
           can_grant  = false,
           updated_at = v_now
     WHERE a.user_id = p_user_id
       AND a.revoked_at IS NULL;

    -- 7-4. 역할 강등. 이미 강등되어 있으면 profiles 는 건드리지 않는다.
    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_user_id;

    IF v_role IS DISTINCT FROM 'super_admin' THEN
        RETURN jsonb_build_object(
            'user_id', p_user_id,
            'revoked', true,
            'demoted', false,
            'role', COALESCE(v_role, ''),
            'revoked_by', p_actor_id
        );
    END IF;

    v_has_wholesaler := EXISTS (
        SELECT 1 FROM public.wholesalers w WHERE w.profile_id = p_user_id
    );

    IF v_has_wholesaler THEN
        v_new_role := 'wholesaler';
        -- 행정 승인 증거는 업체 status 다 (20260914 백필과 동일 기준).
        v_is_verified := EXISTS (
            SELECT 1 FROM public.wholesalers w
             WHERE w.profile_id = p_user_id
               AND w.status = 'active'
        );
    ELSE
        v_new_role := 'retailer';
        v_is_verified := false;
    END IF;

    PERFORM set_config('app.platform_admin_revoke', 'on', true);

    UPDATE public.profiles p
       SET role        = v_new_role,
           is_supplier = v_has_wholesaler,
           is_verified = v_is_verified,
           -- 승인 상태가 꺼지면 심사 흔적도 함께 비운다
           -- (set_supplier_verification 과 같은 규약).
           verified_at = CASE WHEN v_is_verified THEN COALESCE(p.verified_at, v_now) ELSE NULL END,
           verified_by = CASE WHEN v_is_verified THEN p.verified_by ELSE NULL END,
           updated_at  = v_now
     WHERE p.id = p_user_id;

    PERFORM set_config('app.platform_admin_revoke', 'off', true);

    RETURN jsonb_build_object(
        'user_id', p_user_id,
        'revoked', true,
        'demoted', true,
        'role', v_new_role,
        'is_verified', v_is_verified,
        'revoked_by', p_actor_id
    );
END;
$$;

COMMENT ON FUNCTION public.revoke_platform_admin(UUID, UUID) IS
    '관리자 명단 항목을 무효화하고 같은 트랜잭션에서 profiles.role 을 강등한다. service_role 전용.';

-- ====================================================================
-- 8. 호출 경로를 service_role 하나로 좁힌다
--
--    브라우저 세션(anon/authenticated)이 승격/부여/회수 RPC 를 직접 호출할
--    수 있으면 명단 자체가 방어선 역할을 못 한다. 3번의 boolean 헬퍼만
--    authenticated 에 열려 있다.
-- ====================================================================
REVOKE ALL ON FUNCTION public.promote_platform_admin(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grant_platform_admin(UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_platform_admin(UUID, UUID) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION public.promote_platform_admin(UUID, TEXT) FROM anon;
        REVOKE ALL ON FUNCTION public.grant_platform_admin(UUID, UUID, BOOLEAN, TEXT) FROM anon;
        REVOKE ALL ON FUNCTION public.revoke_platform_admin(UUID, UUID) FROM anon;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION public.promote_platform_admin(UUID, TEXT) FROM authenticated;
        REVOKE ALL ON FUNCTION public.grant_platform_admin(UUID, UUID, BOOLEAN, TEXT) FROM authenticated;
        REVOKE ALL ON FUNCTION public.revoke_platform_admin(UUID, UUID) FROM authenticated;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.promote_platform_admin(UUID, TEXT) TO service_role;
        GRANT EXECUTE ON FUNCTION public.grant_platform_admin(UUID, UUID, BOOLEAN, TEXT) TO service_role;
        GRANT EXECUTE ON FUNCTION public.revoke_platform_admin(UUID, UUID) TO service_role;
    END IF;
END;
$$;

-- ====================================================================
-- 9. 구 함수는 새 함수로 위임하는 래퍼로 남긴다
--
--    이 마이그레이션은 3단계(앱 부트스트랩 전환) 이전에 적용되므로,
--    배포 중인 앱은 여전히 bootstrap_super_admin(uid, email) 을 호출한다.
--    시그니처와 반환 키(role/promoted)를 유지해 1단계를 단독 배포 가능하게
--    하고, 3단계를 되돌려도 동작하게 한다.
--
--    동작 차이 한 가지:
--      기존 함수는 이메일 불일치 시 SUPER_ADMIN_EMAIL_MISMATCH 예외를
--      던졌지만, 이제 promoted=false 로 반환된다. 호출부
--      (lib/auth/super-admin-bootstrap.ts)는 role 이 'super_admin' 이
--      아니면 "failed" 로 처리하므로 결과는 같다.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.bootstrap_super_admin(
    p_user_id UUID,
    p_email   TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.promote_platform_admin(p_user_id, p_email);
$$;

COMMENT ON FUNCTION public.bootstrap_super_admin(UUID, TEXT) IS
    '[DEPRECATED] promote_platform_admin 으로 위임하는 호환 래퍼. 신규 코드는 promote_platform_admin 을 호출할 것.';

REVOKE ALL ON FUNCTION public.bootstrap_super_admin(UUID, TEXT) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION public.bootstrap_super_admin(UUID, TEXT) FROM anon;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION public.bootstrap_super_admin(UUID, TEXT) FROM authenticated;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.bootstrap_super_admin(UUID, TEXT) TO service_role;
    END IF;
END;
$$;

-- ====================================================================
-- 10. 백필 — 기존 슈퍼관리자를 명단에 등재한다
--
--     이 단계가 없으면 5단계(트리거 강화: 명단에 없으면 super_admin 쓰기
--     금지)를 적용하는 순간 현재 운영자가 잠긴다. 또한 명단 화면이
--     "관리자 0명"으로 보이는 문제도 여기서 해소된다.
--
--     can_grant = true 로 넣는 이유: 백필 대상은 현재 유일한 운영자이며,
--     이 사람이 직원을 등재해야 명단 기능이 시작된다.
-- ====================================================================
INSERT INTO public.platform_admin_allowlist (user_id, can_grant, source, note)
SELECT p.id, true, 'migration_backfill', '기존 슈퍼관리자 백필 (20260916000000)'
  FROM public.profiles p
 WHERE p.role = 'super_admin'
   AND NOT EXISTS (
       SELECT 1
         FROM public.platform_admin_allowlist a
        WHERE a.user_id = p.id
          AND a.revoked_at IS NULL
   );
