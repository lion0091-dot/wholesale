-- ====================================================================
-- 플랫폼 슈퍼관리자 셀프 부트스트랩 (환경변수 기반)
--
-- 문제:
--   슈퍼관리자(profiles.role = 'super_admin')는 "첫 한 명"을 만들 방법이 없었다.
--   승격 경로가 전부 슈퍼관리자 전용이라(4번 트리거) 닭과 달걀 문제가 생기고,
--   결국 운영자가 Supabase 콘솔에서 직접 UPDATE 하는 수동 절차에 의존했다.
--
-- 해결:
--   서버 전용 환경변수 SUPER_ADMIN_EMAIL 에 적힌 이메일로 로그인하면
--   콜백(/auth/callback)에서 서비스 롤로 이 함수를 호출해 스스로 승격한다.
--   이후 모든 권한 판정은 여전히 DB(profiles.role) 하나만 본다.
--
-- 신뢰 경계:
--   · 허용 이메일 목록은 브라우저에 절대 내려가지 않는 서버 환경변수다.
--   · 이 함수는 service_role 에게만 EXECUTE 를 준다. anon/authenticated 는
--     REVOKE 되므로 브라우저에서 PostgREST 로 직접 호출할 수 없다.
--   · 그럼에도 호출자가 넘긴 이메일을 신뢰하지 않고 auth.users 로 재확인해
--     "UUID ↔ 이메일" 결속을 DB 안에서 한 번 더 검증한다.
--     (임의 UUID 를 이메일만 바꿔 승격시키는 실수/오용을 막는다)
--
-- 이 마이그레이션은 전체가 멱등(idempotent)하므로 재실행해도 안전하다.
-- ====================================================================

-- ====================================================================
-- 1. 권한 플래그 자기 승격 차단 트리거 — 부트스트랩 전용 예외 추가
--
--    기존 예외는 'app.supplier_onboarding'(공급사 온보딩) 하나뿐이었다.
--    슈퍼관리자 승격은 목적이 전혀 다르므로 플래그를 분리한다.
--    (로그/장애 분석 때 어떤 경로가 role 을 바꿨는지 구분할 수 있어야 한다)
--
--    두 플래그 모두 SECURITY DEFINER 함수 내부에서만 set_config 되고,
--    권한이 필요한 UPDATE 직후 즉시 'off' 로 되돌린다. is_local => true 는
--    '함수 종료'가 아니라 '트랜잭션 종료'까지 유지되기 때문이다.
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

DROP TRIGGER IF EXISTS trg_profiles_role_immutable ON public.profiles;

CREATE TRIGGER trg_profiles_role_immutable
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_role_immutable();

-- ====================================================================
-- 2. 슈퍼관리자 승격 (service_role 전용)
--
--    반환값:
--      { user_id, email, role, promoted }
--      promoted = false  → 이미 슈퍼관리자였다 (재실행/재로그인)
--
--    예외:
--      SUPER_ADMIN_BOOTSTRAP_INVALID_INPUT  인수 누락
--      SUPER_ADMIN_EMAIL_MISMATCH           UUID 의 실제 이메일과 불일치
--                                           (카카오가 이메일을 주지 않은 계정 포함)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.bootstrap_super_admin(
    p_user_id UUID,
    p_email   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now          TIMESTAMPTZ := now();
    v_email        TEXT := lower(btrim(COALESCE(p_email, '')));
    v_actual_email TEXT;
    v_role         TEXT;
    v_name         TEXT;
BEGIN
    IF p_user_id IS NULL OR v_email = '' THEN
        RAISE EXCEPTION 'SUPER_ADMIN_BOOTSTRAP_INVALID_INPUT';
    END IF;

    -- 2-1. UUID ↔ 이메일 결속 확인. 호출자가 준 이메일은 근거로 쓰지 않는다.
    SELECT lower(btrim(u.email)),
           COALESCE(
               NULLIF(u.raw_user_meta_data ->> 'name', ''),
               NULLIF(u.raw_user_meta_data ->> 'full_name', ''),
               NULLIF(u.raw_user_meta_data ->> 'preferred_username', ''),
               '플랫폼 관리자'
           )
      INTO v_actual_email, v_name
      FROM auth.users u
     WHERE u.id = p_user_id;

    IF v_actual_email IS NULL OR v_actual_email <> v_email THEN
        RAISE EXCEPTION 'SUPER_ADMIN_EMAIL_MISMATCH';
    END IF;

    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_user_id;

    -- 2-2. 멱등 — 로그인마다 호출되므로 이미 슈퍼관리자면 아무것도 쓰지 않는다.
    IF v_role = 'super_admin' THEN
        RETURN jsonb_build_object(
            'user_id', p_user_id,
            'email', v_actual_email,
            'role', v_role,
            'promoted', false
        );
    END IF;

    PERFORM set_config('app.super_admin_bootstrap', 'on', true);

    IF v_role IS NULL THEN
        -- 트리거(handle_new_user)보다 콜백이 먼저 도달하는 경우는 없지만,
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
               -- 운영자 계정이 공급사 온보딩까지 마친 상태(개발/시연 겸용)라면
               -- 공급사 기능을 잃지 않도록 업체 레코드 보유 여부를 그대로 따른다.
               is_supplier = EXISTS (
                   SELECT 1 FROM public.wholesalers w WHERE w.profile_id = p_user_id
               ),
               -- 슈퍼관리자는 행정 승인 심사 대상이 아니다.
               is_verified = true,
               verified_at = COALESCE(p.verified_at, v_now),
               -- verified_by 는 비워 둔다. 사람이 심사한 승인과 환경변수
               -- 부트스트랩을 감사 기록에서 구분하기 위한 의도적 NULL 이다.
               updated_at = v_now
         WHERE p.id = p_user_id;
    END IF;

    -- 권한 우회 창을 profiles 쓰기 한 문장으로 제한한다.
    PERFORM set_config('app.super_admin_bootstrap', 'off', true);

    RETURN jsonb_build_object(
        'user_id', p_user_id,
        'email', v_actual_email,
        'role', 'super_admin',
        'promoted', true
    );
END;
$$;

COMMENT ON FUNCTION public.bootstrap_super_admin(UUID, TEXT) IS
    '서버 환경변수(SUPER_ADMIN_EMAIL) 허용 계정을 슈퍼관리자로 승격한다. service_role 전용.';

-- 2-3. 호출 경로를 service_role 하나로 좁힌다.
--      (브라우저 세션의 anon/authenticated 로는 PostgREST RPC 가 닫힌다)
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
