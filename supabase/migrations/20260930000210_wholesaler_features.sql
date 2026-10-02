-- 업체별 기능 켜기/끄기 + 첫 기능 "원가 관리"(마진 패널 + 재고 평가) (2026-10-02)
--
-- ■ 쉬운 설명 (이 구조를 모르는 사람도 읽을 수 있게)
--   platform_features      = "기능 메뉴판". 팔 수 있는 기능이 한 줄씩 적혀 있다(이름·설명·기본 켜짐/꺼짐).
--   wholesaler_features    = "업체별 주문서". 이 업체는 이 기능을 켰다/껐다. 적힌 게 없으면 메뉴판의 기본값을 따른다.
--   feature_enabled(업체,기능) = "이 업체가 이 기능을 쓰나요?" 하는 질문 하나. 화면도 DB 함수도 이것만 부른다.
--   set_wholesaler_feature  = 켜고 끄는 유일한 입구. 플랫폼 운영자(슈퍼관리자)만 부를 수 있다.
--   새 기능을 팔려면: 메뉴판에 한 줄 등록 → 그 기능 코드 맨 앞에서 "쓰나요?"를 묻는다. 표를 새로 만들 일이 없다.
--   핵심 업무(주문·입고·출고·재고·상품 관리)에는 끄는 칸을 두지 않는다.
--   wholesaler_feature_periods = "켜진 기간 이력". 언제부터 언제까지 누가 켜고 껐는지(고칠 수 없음, 청구·일할 계산의 근거).
--
-- ■ 지금 상태
--   "원가 관리"(cost_management)는 모든 업체에 켜진 상태로 시작한다(default_enabled = true).

-- ============================================================
-- 1. 표
-- ============================================================
CREATE TABLE IF NOT EXISTS public.platform_features (
    key             text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
    label           text NOT NULL,
    description     text,
    default_enabled boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wholesaler_features (
    wholesaler_id uuid NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    feature_key   text NOT NULL REFERENCES public.platform_features(key) ON DELETE CASCADE,
    enabled       boolean NOT NULL,
    config        jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (wholesaler_id, feature_key)
);

ALTER TABLE public.platform_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wholesaler_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Platform features viewable by authenticated" ON public.platform_features;
CREATE POLICY "Platform features viewable by authenticated"
    ON public.platform_features FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Wholesaler features viewable by supplier staff" ON public.wholesaler_features;
CREATE POLICY "Wholesaler features viewable by supplier staff"
    ON public.wholesaler_features FOR SELECT USING (public.can_access_wholesaler(wholesaler_id));

-- 쓰기 정책은 두지 않는다 — 켜고 끄는 건 set_wholesaler_feature(슈퍼관리자 전용)만.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.platform_features FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.wholesaler_features FROM anon, authenticated;
REVOKE ALL ON public.platform_features FROM anon;
REVOKE ALL ON public.wholesaler_features FROM anon;

-- ============================================================
-- 2. 질문·조회·설정 함수
-- ============================================================
CREATE OR REPLACE FUNCTION public.feature_enabled(p_wholesaler_id uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT COALESCE(
        (SELECT f.enabled FROM public.wholesaler_features f
          WHERE f.wholesaler_id = p_wholesaler_id AND f.feature_key = p_key),
        (SELECT p.default_enabled FROM public.platform_features p WHERE p.key = p_key),
        false
    );
$$;

-- 지금 로그인한 업체에서 켜져 있는 기능과 세부 설정. 화면(사이드 탭 등)이 한 번의 호출로 쓴다.
CREATE OR REPLACE FUNCTION public.current_wholesaler_features()
RETURNS TABLE (feature_key text, config jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    WITH me AS MATERIALIZED (SELECT public.resolve_current_wholesaler_id() AS wid)
    SELECT p.key, COALESCE(f.config, '{}'::jsonb)
    FROM me
    CROSS JOIN public.platform_features p
    LEFT JOIN public.wholesaler_features f ON f.feature_key = p.key AND f.wholesaler_id = me.wid
    WHERE me.wid IS NOT NULL
      AND COALESCE(f.enabled, p.default_enabled);
$$;

DROP FUNCTION IF EXISTS public.admin_list_wholesaler_features();

-- 어드민 화면용: 모든 업체 × 모든 기능의 현재 상태(켜짐 여부, 업체에 직접 정한 값인지 기본값인지).
CREATE OR REPLACE FUNCTION public.admin_list_wholesaler_features()
RETURNS TABLE (
    wholesaler_id uuid, business_name text, feature_key text, feature_label text,
    enabled boolean, is_override boolean, config jsonb
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
BEGIN
    IF COALESCE(public.get_current_role() = 'super_admin', false) IS NOT TRUE THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    RETURN QUERY
    SELECT w.id, w.business_name, p.key, p.label,
           COALESCE(f.enabled, p.default_enabled),
           f.feature_key IS NOT NULL,
           COALESCE(f.config, '{}'::jsonb)
    FROM public.wholesalers w
    CROSS JOIN public.platform_features p
    LEFT JOIN public.wholesaler_features f ON f.wholesaler_id = w.id AND f.feature_key = p.key
    ORDER BY w.business_name, p.key;
END;
$$;

REVOKE ALL ON FUNCTION public.feature_enabled(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_wholesaler_features() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_wholesaler_features() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feature_enabled(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_wholesaler_features() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_wholesaler_features() TO authenticated, service_role;

-- ============================================================
-- 2-2. 켜진 기간 이력 — "언제부터 언제까지, 누가 켜고 껐는지" (청구·일할 계산을 하게 될 때 그대로 합산할 수 있는 원장)
--      규칙(불변식): 이 업체에서 기능이 지금 켜져 있다 ⇔ ended_at이 비어 있는(진행 중) 기간이 정확히 한 줄 있다.
--      · 켜면 새 기간이 시작되고, 끄면 진행 중 기간이 끝난다(set_wholesaler_feature만이 바꾼다).
--      · 기본 켜짐 기능은 업체가 생길 때 / 기능을 등록할 때 진행 중 기간을 함께 열어 둔다(started_by 없음 = 시스템 기본값).
--      · 한 번 적힌 기록은 고치거나 지울 수 없다 — 끝나는 시각만 한 번 채워진다. 이력은 이 마이그레이션을 적용한 시점부터 쌓인다.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wholesaler_feature_periods (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id uuid NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    feature_key   text NOT NULL REFERENCES public.platform_features(key) ON DELETE CASCADE,
    started_at    timestamptz NOT NULL DEFAULT now(),
    ended_at      timestamptz,
    started_by    uuid,
    ended_by      uuid,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_periods_one_open
    ON public.wholesaler_feature_periods (wholesaler_id, feature_key) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feature_periods_wholesaler
    ON public.wholesaler_feature_periods (wholesaler_id, started_at DESC);

-- 읽기·쓰기 정책을 두지 않는다 — 읽기는 admin_list_feature_periods(슈퍼관리자 전용), 쓰기는 아래 함수들만.
ALTER TABLE public.wholesaler_feature_periods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wholesaler_feature_periods FROM anon, authenticated;

-- 고치기 금지: 진행 중인 기간의 끝(ended_at, ended_by)을 한 번 채우는 것만 허용한다.
CREATE OR REPLACE FUNCTION public.guard_feature_period_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
    IF OLD.ended_at IS NOT NULL
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.wholesaler_id IS DISTINCT FROM OLD.wholesaler_id
       OR NEW.feature_key IS DISTINCT FROM OLD.feature_key
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.started_by IS DISTINCT FROM OLD.started_by THEN
        RAISE EXCEPTION 'HISTORY_IMMUTABLE';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_feature_period_history ON public.wholesaler_feature_periods;
CREATE TRIGGER trg_guard_feature_period_history
    BEFORE UPDATE ON public.wholesaler_feature_periods
    FOR EACH ROW EXECUTE FUNCTION public.guard_feature_period_history();

REVOKE ALL ON FUNCTION public.guard_feature_period_history() FROM PUBLIC, anon, authenticated;

-- 새 업체가 생기면 기본 켜짐 기능의 기간을 함께 연다.
CREATE OR REPLACE FUNCTION public.open_feature_periods_for_new_wholesaler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    INSERT INTO public.wholesaler_feature_periods (wholesaler_id, feature_key, started_at, started_by)
    SELECT NEW.id, p.key, now(), NULL
    FROM public.platform_features p
    WHERE p.default_enabled
    ON CONFLICT (wholesaler_id, feature_key) WHERE ended_at IS NULL DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_open_feature_periods_for_new_wholesaler ON public.wholesalers;
CREATE TRIGGER trg_open_feature_periods_for_new_wholesaler
    AFTER INSERT ON public.wholesalers
    FOR EACH ROW EXECUTE FUNCTION public.open_feature_periods_for_new_wholesaler();

REVOKE ALL ON FUNCTION public.open_feature_periods_for_new_wholesaler() FROM PUBLIC, anon, authenticated;

-- 기본 켜짐 기능을 새로 등록하는 마이그레이션이 부른다: 지금 켜져 있는 모든 업체에 진행 중 기간을 열어 둔다(이미 열려 있으면 건너뜀).
CREATE OR REPLACE FUNCTION public.open_default_feature_periods(p_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_count integer;
BEGIN
    INSERT INTO public.wholesaler_feature_periods (wholesaler_id, feature_key, started_at, started_by)
    SELECT w.id, p_key, now(), NULL
    FROM public.wholesalers w
    WHERE public.feature_enabled(w.id, p_key)
    ON CONFLICT (wholesaler_id, feature_key) WHERE ended_at IS NULL DO NOTHING;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.open_default_feature_periods(text) FROM PUBLIC, anon, authenticated;

-- 켜고 끄는 유일한 입구(플랫폼 운영자 전용). 켜짐/꺼짐이 실제로 바뀔 때만 기간을 열고 닫는다. p_config가 null이면 기존 세부 설정을 그대로 둔다.
CREATE OR REPLACE FUNCTION public.set_wholesaler_feature(
    p_wholesaler_id uuid, p_key text, p_enabled boolean, p_config jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_before boolean;
    v_closed integer;
BEGIN
    IF COALESCE(public.get_current_role() = 'super_admin', false) IS NOT TRUE THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.platform_features WHERE key = p_key) THEN
        RAISE EXCEPTION 'UNKNOWN_FEATURE';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.wholesalers WHERE id = p_wholesaler_id) THEN
        RAISE EXCEPTION 'WHOLESALER_NOT_FOUND';
    END IF;

    IF p_config IS NOT NULL AND jsonb_typeof(p_config) <> 'object' THEN
        RAISE EXCEPTION 'INVALID_CONFIG';
    END IF;

    -- 같은 업체·기능을 동시에 바꾸는 경우 기간 기록이 어긋나지 않게 순서를 세운다.
    PERFORM pg_advisory_xact_lock(hashtext(p_wholesaler_id::text || ':' || p_key));

    v_before := public.feature_enabled(p_wholesaler_id, p_key);

    INSERT INTO public.wholesaler_features (wholesaler_id, feature_key, enabled, config, updated_by)
    VALUES (p_wholesaler_id, p_key, p_enabled, COALESCE(p_config, '{}'::jsonb), auth.uid())
    ON CONFLICT (wholesaler_id, feature_key) DO UPDATE
       SET enabled    = EXCLUDED.enabled,
           config     = CASE WHEN p_config IS NULL THEN public.wholesaler_features.config ELSE EXCLUDED.config END,
           updated_by = EXCLUDED.updated_by,
           updated_at = now();

    IF p_enabled AND NOT v_before THEN
        INSERT INTO public.wholesaler_feature_periods (wholesaler_id, feature_key, started_at, started_by)
        VALUES (p_wholesaler_id, p_key, now(), auth.uid())
        ON CONFLICT (wholesaler_id, feature_key) WHERE ended_at IS NULL DO NOTHING;
    ELSIF NOT p_enabled AND v_before THEN
        UPDATE public.wholesaler_feature_periods
           SET ended_at = now(), ended_by = auth.uid()
         WHERE wholesaler_id = p_wholesaler_id AND feature_key = p_key AND ended_at IS NULL;

        GET DIAGNOSTICS v_closed = ROW_COUNT;

        -- 불변식이 깨져 진행 중 기간이 없던 경우(이력이 쌓이기 전 기능): 시작 시각을 모르니 지금 열고 바로 닫아 끈 사실만 남긴다.
        IF v_closed = 0 THEN
            INSERT INTO public.wholesaler_feature_periods (wholesaler_id, feature_key, started_at, ended_at, started_by, ended_by)
            VALUES (p_wholesaler_id, p_key, now(), now(), NULL, auth.uid());
        END IF;
    END IF;
END;
$$;

-- 어드민 화면용: 켜진 기간 이력(최근 순). 업체·기능을 좁혀 볼 수 있다. 슈퍼관리자 전용.
CREATE OR REPLACE FUNCTION public.admin_list_feature_periods(
    p_wholesaler_id uuid DEFAULT NULL, p_key text DEFAULT NULL, p_limit integer DEFAULT 200
)
RETURNS TABLE (
    period_id uuid, wholesaler_id uuid, business_name text, feature_key text, feature_label text,
    started_at timestamptz, ended_at timestamptz, started_by_name text, ended_by_name text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
BEGIN
    IF COALESCE(public.get_current_role() = 'super_admin', false) IS NOT TRUE THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    RETURN QUERY
    SELECT h.id, h.wholesaler_id, w.business_name, h.feature_key, f.label,
           h.started_at, h.ended_at,
           CASE WHEN h.started_by IS NULL THEN '시스템(기본값)' ELSE COALESCE(sp.name, '알 수 없음') END,
           CASE WHEN h.ended_at IS NULL THEN NULL
                WHEN h.ended_by IS NULL THEN '시스템'
                ELSE COALESCE(ep.name, '알 수 없음') END
    FROM public.wholesaler_feature_periods h
    JOIN public.wholesalers w ON w.id = h.wholesaler_id
    JOIN public.platform_features f ON f.key = h.feature_key
    LEFT JOIN public.profiles sp ON sp.id = h.started_by
    LEFT JOIN public.profiles ep ON ep.id = h.ended_by
    WHERE (p_wholesaler_id IS NULL OR h.wholesaler_id = p_wholesaler_id)
      AND (p_key IS NULL OR h.feature_key = p_key)
    ORDER BY h.started_at DESC, h.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
END;
$$;

-- 점검용: 불변식이 깨진 곳(켜져 있는데 진행 중 기간이 없음 / 꺼져 있는데 진행 중 기간이 있음)을 돌려준다. 없어야 정상이다. 슈퍼관리자 전용.
CREATE OR REPLACE FUNCTION public.feature_period_violations()
RETURNS TABLE (wholesaler_id uuid, feature_key text, effective_enabled boolean, open_periods integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
BEGIN
    IF COALESCE(public.get_current_role() = 'super_admin', false) IS NOT TRUE THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    RETURN QUERY
    SELECT s.wholesaler_id, s.feature_key, s.enabled, s.opened
    FROM (
        SELECT w.id AS wholesaler_id, p.key AS feature_key,
               public.feature_enabled(w.id, p.key) AS enabled,
               (SELECT count(*)::integer FROM public.wholesaler_feature_periods h
                 WHERE h.wholesaler_id = w.id AND h.feature_key = p.key AND h.ended_at IS NULL) AS opened
        FROM public.wholesalers w
        CROSS JOIN public.platform_features p
    ) s
    WHERE s.enabled <> (s.opened > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.set_wholesaler_feature(uuid, text, boolean, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_feature_periods(uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feature_period_violations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_wholesaler_feature(uuid, text, boolean, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_feature_periods(uuid, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feature_period_violations() TO authenticated, service_role;

-- ============================================================
-- 3. 대표(업체 소유자) 판정 — 슈퍼관리자·매니저·직원은 아니다
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_wholesaler_owner(p_wholesaler_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT COALESCE(
        p_wholesaler_id IS NOT NULL
        AND (
            p_wholesaler_id = public.get_current_wholesaler_id()
            OR public.is_org_staff_of_wholesaler(p_wholesaler_id, ARRAY['owner']::public.organization_role[])
        ),
        false
    );
$$;

REVOKE ALL ON FUNCTION public.is_wholesaler_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_wholesaler_owner(uuid) TO authenticated, service_role;

-- ============================================================
-- 3-2. 기능을 "누가" 쓰나 — 켜진 기능이라도 업체 대표가 허용한 사람만 (기능 키별 허용 목록)
--      대표는 항상 쓴다. 매니저·직원은 대표가 허용했을 때만. 슈퍼관리자는 업체 안의 기능을 쓰지 않는다.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wholesaler_feature_viewers (
    wholesaler_id uuid NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    feature_key   text NOT NULL REFERENCES public.platform_features(key) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    granted_by    uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (wholesaler_id, feature_key, user_id)
);

ALTER TABLE public.wholesaler_feature_viewers ENABLE ROW LEVEL SECURITY;

-- 읽기: 대표(허용 목록 관리 화면) 또는 본인 행. 쓰기 정책은 없다 — set_feature_viewer(대표 전용)만.
DROP POLICY IF EXISTS "Feature viewers viewable by owner or self" ON public.wholesaler_feature_viewers;
CREATE POLICY "Feature viewers viewable by owner or self"
    ON public.wholesaler_feature_viewers FOR SELECT
    USING (user_id = auth.uid() OR public.is_wholesaler_owner(wholesaler_id));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.wholesaler_feature_viewers FROM anon, authenticated;
REVOKE ALL ON public.wholesaler_feature_viewers FROM anon;

-- "이 사람이 이 업체에서 이 기능을 쓸 수 있나": 기능이 켜져 있고 + (대표이거나 대표가 허용한 사람)
CREATE OR REPLACE FUNCTION public.can_use_feature(p_wholesaler_id uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT COALESCE(
        public.feature_enabled(p_wholesaler_id, p_key)
        AND (
            public.is_wholesaler_owner(p_wholesaler_id)
            OR EXISTS (
                SELECT 1 FROM public.wholesaler_feature_viewers v
                 WHERE v.wholesaler_id = p_wholesaler_id AND v.feature_key = p_key AND v.user_id = auth.uid()
            )
        ),
        false
    );
$$;

-- 대표가 같은 업체 직원·매니저에게 기능 사용을 허용/해제한다. 켜져 있지 않은 기능은 허용 목록을 만질 수 없다.
CREATE OR REPLACE FUNCTION public.set_feature_viewer(p_key text, p_user_id uuid, p_allowed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF NOT public.feature_enabled(v_wid, p_key) THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    IF p_allowed THEN
        -- 같은 업체의 매니저·직원만 허용할 수 있다(대표는 항상 쓰고, 다른 업체 사람은 안 된다).
        IF NOT EXISTS (
            SELECT 1
            FROM public.organization_staff s
            JOIN public.organizations o ON o.id = s.organization_id
            WHERE o.wholesaler_id = v_wid AND s.user_id = p_user_id AND s.role IN ('manager', 'staff')
        ) THEN
            RAISE EXCEPTION 'NOT_A_MEMBER';
        END IF;

        INSERT INTO public.wholesaler_feature_viewers (wholesaler_id, feature_key, user_id, granted_by)
        VALUES (v_wid, p_key, p_user_id, auth.uid())
        ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM public.wholesaler_feature_viewers
         WHERE wholesaler_id = v_wid AND feature_key = p_key AND user_id = p_user_id;
    END IF;
END;
$$;

-- 대표용: 이 기능을 쓰도록 허용한 사람 목록(팀원 관리 화면이 쓴다).
CREATE OR REPLACE FUNCTION public.list_feature_viewers(p_key text)
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT v.user_id
    FROM public.wholesaler_feature_viewers v
    WHERE v.wholesaler_id = public.resolve_current_wholesaler_id()
      AND v.feature_key = p_key
      AND public.is_wholesaler_owner(v.wholesaler_id);
$$;

-- 로그인한 사람이 지금 쓸 수 있는 기능 목록(사이드 탭 등 화면용). 업체 단위가 아니라 "나" 기준이다.
CREATE OR REPLACE FUNCTION public.my_usable_features()
RETURNS TABLE (feature_key text, config jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT f.feature_key, f.config
    FROM public.current_wholesaler_features() f
    WHERE public.can_use_feature(public.resolve_current_wholesaler_id(), f.feature_key);
$$;

REVOKE ALL ON FUNCTION public.can_use_feature(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_feature_viewer(text, uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_feature_viewers(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_usable_features() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_use_feature(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_feature_viewer(text, uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_feature_viewers(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_usable_features() TO authenticated, service_role;

-- ============================================================
-- 4. 기능 "원가 관리" 등록 — 마진 패널(주문 상세) + 재고 평가(재고·매입 내역의 탭). 지금은 모든 업체에 켜짐.
-- ============================================================
INSERT INTO public.platform_features (key, label, description, default_enabled) VALUES
    ('cost_management', '원가 관리',
     '주문별 마진(나간 박스의 매입단가)과 재고 평가금액(남은 박스의 매입단가)을 보여줍니다. 대표와 대표가 허용한 사람만 봅니다.',
     true)
ON CONFLICT (key) DO NOTHING;

-- 기본 켜짐 기능을 등록했으니, 지금 켜져 있는 모든 업체의 "켜진 기간"을 오늘부터 연다.
SELECT public.open_default_feature_periods('cost_management');

-- 접근 검사 한 곳: 이 업체에서 원가 관리가 켜져 있고, 대표이거나 대표가 허용한 사람이어야 한다. 통과하면 업체 id를 돌려준다.
CREATE OR REPLACE FUNCTION public.assert_cost_management_access()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL THEN
        RAISE EXCEPTION 'NOT_ALLOWED';
    END IF;

    IF NOT public.feature_enabled(v_wid, 'cost_management') THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    -- 켜져 있어도 대표가 허용한 사람만(대표는 항상). 매니저·직원은 팀원 관리에서 대표가 허용해야 한다.
    IF NOT public.can_use_feature(v_wid, 'cost_management') THEN
        RAISE EXCEPTION 'NOT_ALLOWED';
    END IF;

    RETURN v_wid;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_cost_management_access() FROM PUBLIC, anon, authenticated;

-- 재고 평가(상품별 요약). 평가금액 = 남은 박스 kg × 그 박스의 매입단가. 단가를 모르는 kg(단가 미입력 박스)와
-- 박스 없는 재고(수동 재고)는 0원으로 치지 않고 따로 돌려준다 — 화면이 "미완성"으로 표시한다.
CREATE OR REPLACE FUNCTION public.get_inventory_valuation()
RETURNS TABLE (
    product_id    uuid,
    product_name  text,
    unit          text,
    box_count     integer,
    remaining_qty numeric,
    valued_qty    numeric,
    value_amount  numeric,
    unpriced_qty  numeric,
    boxless_qty   numeric,
    oldest_at     timestamptz,
    oldest_days   integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.assert_cost_management_access();
BEGIN
    RETURN QUERY
    WITH boxes AS (
        SELECT s.product_id,
               count(*)::integer AS n,
               sum(s.remaining_weight) AS qty,
               COALESCE(sum(s.remaining_weight) FILTER (WHERE s.purchase_unit_price IS NOT NULL), 0) AS valued,
               COALESCE(sum(s.remaining_weight * s.purchase_unit_price), 0) AS amount,
               COALESCE(sum(s.remaining_weight) FILTER (WHERE s.purchase_unit_price IS NULL), 0) AS unpriced,
               min(s.created_at) AS oldest
        FROM public.inbound_scans s
        WHERE s.wholesaler_id = v_wid
          AND s.status = 'NORMAL'
          AND s.remaining_weight > 0
          AND s.product_id IS NOT NULL
        GROUP BY s.product_id
    )
    SELECT p.id,
           p.name,
           p.unit,
           COALESCE(b.n, 0),
           COALESCE(b.qty, 0),
           COALESCE(b.valued, 0),
           round(COALESCE(b.amount, 0), 0),
           COALESCE(b.unpriced, 0),
           GREATEST(p.stock_quantity - COALESCE(b.qty, 0), 0),
           b.oldest,
           CASE WHEN b.oldest IS NULL THEN NULL
                ELSE GREATEST((CURRENT_DATE - (b.oldest AT TIME ZONE 'Asia/Seoul')::date), 0) END
    FROM public.products p
    LEFT JOIN boxes b ON b.product_id = p.id
    WHERE p.wholesaler_id = v_wid
      AND (COALESCE(b.qty, 0) > 0 OR p.stock_quantity > 0)
    ORDER BY b.oldest ASC NULLS LAST, p.name ASC;
END;
$$;

-- 한 상품의 남은 박스 목록(오래된 순). 화면에서 상품을 펼칠 때만 부른다.
CREATE OR REPLACE FUNCTION public.get_inventory_valuation_boxes(p_product_id uuid, p_limit integer DEFAULT 200)
RETURNS TABLE (
    scan_id          uuid,
    trace_no         text,
    remaining_weight numeric,
    unit_price       numeric,
    value_amount     numeric,
    created_at       timestamptz,
    days_old         integer,
    best_before      date,
    total_count      bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.assert_cost_management_access();
BEGIN
    RETURN QUERY
    SELECT s.id,
           s.trace_no,
           s.remaining_weight,
           s.purchase_unit_price,
           round(s.remaining_weight * s.purchase_unit_price, 0),
           s.created_at,
           GREATEST((CURRENT_DATE - (s.created_at AT TIME ZONE 'Asia/Seoul')::date), 0),
           s.best_before,
           count(*) OVER ()
    FROM public.inbound_scans s
    WHERE s.wholesaler_id = v_wid
      AND s.product_id = p_product_id
      AND s.status = 'NORMAL'
      AND s.remaining_weight > 0
    ORDER BY s.created_at ASC, s.trace_no ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
END;
$$;

REVOKE ALL ON FUNCTION public.get_inventory_valuation() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_inventory_valuation_boxes(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_valuation() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_inventory_valuation_boxes(uuid, integer) TO authenticated, service_role;

-- ============================================================
-- 5. 주문별 마진(208)도 같은 기능 아래로 — 꺼진 업체나 허용 안 된 사람에게는 데이터를 주지 않는다. 계산 본문은 208 그대로.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_order_margin(p_order_id uuid)
RETURNS TABLE (
    product_id    uuid,
    product_name  text,
    unit          text,
    sold_qty      numeric,
    sales_amount  numeric,
    shipped_qty   numeric,
    cost_amount   numeric,
    unpriced_qty  numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wholesaler_id uuid;
BEGIN
    SELECT o.wholesaler_id INTO v_wholesaler_id FROM public.orders o WHERE o.id = p_order_id;

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF NOT public.feature_enabled(v_wholesaler_id, 'cost_management') THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    -- 대표이거나 대표가 허용한 사람(자기 업체 주문만). 허용이 없는 매니저·직원, 타사, 슈퍼관리자는 거부.
    IF NOT public.can_use_feature(v_wholesaler_id, 'cost_management') THEN
        RAISE EXCEPTION 'NOT_OWNER';
    END IF;

    RETURN QUERY
    WITH items AS (
        SELECT oi.product_id,
               max(oi.product_name) AS product_name,
               sum(oi.quantity) AS qty,
               sum(oi.subtotal_amount) AS amount
        FROM public.order_items oi
        WHERE oi.order_id = p_order_id
        GROUP BY oi.product_id
    ),
    net AS (
        -- 이 주문에서 상품·박스별로 순수하게 나간 양(배정 정정·취소 원복 반영). apply_order_shipment의 계산식과 같은 이벤트 4종.
        SELECT l.product_id, l.inbound_scan_id, -sum(l.qty_delta) AS qty
        FROM public.stock_ledger l
        WHERE l.source_type = 'order'
          AND l.source_id = p_order_id
          AND l.event_type IN ('ORDER_OUT', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN', 'ORDER_RESTORE')
        GROUP BY l.product_id, l.inbound_scan_id
        HAVING sum(l.qty_delta) <> 0
    ),
    cost AS (
        SELECT n.product_id,
               sum(n.qty) AS shipped,
               COALESCE(sum(n.qty * s.purchase_unit_price) FILTER (WHERE s.purchase_unit_price IS NOT NULL), 0) AS cost_amount,
               COALESCE(sum(n.qty) FILTER (WHERE s.purchase_unit_price IS NULL), 0) AS unpriced
        FROM net n
        LEFT JOIN public.inbound_scans s ON s.id = n.inbound_scan_id
        GROUP BY n.product_id
    )
    SELECT it.product_id,
           it.product_name,
           p.unit,
           it.qty,
           it.amount,
           COALESCE(c.shipped, 0),
           round(COALESCE(c.cost_amount, 0), 0),
           COALESCE(c.unpriced, 0)
    FROM items it
    LEFT JOIN public.products p ON p.id = it.product_id
    LEFT JOIN cost c ON c.product_id = it.product_id
    ORDER BY it.product_name;
END;
$$;
