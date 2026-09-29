-- ====================================================================
-- 경쟁사 위장가입 방지 2단계 — 초대 전화번호 대조 + 승인대기 상태
--
-- 156에서 만든 retailer_invites(공급사가 등록한 "이 번호는 초대했다" 기록)를
-- claim_shop_access()가 실제로 사용하도록 연결한다.
--
-- wholesaler_retailers.status에 'pending_review'를 추가한다:
--   - 신규 거래 관계 생성 시, 손님의 카카오 전화번호가 그 공급사의 미소진
--     초대 기록과 일치하면 바로 'active'(지금과 동일한 무마찰 경험).
--   - 일치하지 않거나(경쟁사가 전달받은 링크로 들어온 경우 등) 전화번호
--     자체를 카카오가 안 넘겨준 경우 'pending_review'로 떨어진다.
--   - 카탈로그 노출(경쟁사가 보려는 것)은 이 마이그레이션이 아니라
--     lib/shop/catalog.ts 쪽 수정(별도 커밋)이 isLinked=false를 가로막는다.
--     'pending_review'는 isLinked 판정(status==='active')에서 자연히
--     false로 떨어지므로 추가 분기 없이 기존 게이트를 그대로 탄다.
--
-- 승인/거절은 새 RPC를 만들지 않고 기존 set_wholesaler_retailer_status()를
-- 그대로 재사용한다 — 그 함수는 원래 상태(FROM)를 안 가리고 목표 상태(TO)가
-- 'active'/'blocked'인지만 검사하므로 pending_review → active(승인),
-- pending_review → blocked(거절)에 수정 없이 그대로 쓸 수 있다.
-- ====================================================================

ALTER TABLE public.wholesaler_retailers
    DROP CONSTRAINT wholesaler_retailers_status_check;

ALTER TABLE public.wholesaler_retailers
    ADD CONSTRAINT wholesaler_retailers_status_check
    CHECK (status = ANY (ARRAY['active'::text, 'blocked'::text, 'pending_review'::text]));

-- --------------------------------------------------------------------
-- 초대 등록 — 공급사(owner/manager)가 손님 전화번호를 미리 등록한다.
-- 같은 (공급사, 번호) 조합의 미소진 초대가 있으면 새로 만들지 않고 갱신한다
-- (재초대 시 30일 유효기간이 다시 연장됨).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_retailer_invite(
    p_phone TEXT,
    p_customer_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_phone         TEXT := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
    v_invite_id     UUID;
BEGIN
    SELECT COALESCE(
               public.get_current_wholesaler_id(),
               (
                   SELECT o.wholesaler_id
                     FROM public.organization_staff s
                     JOIN public.organizations o ON o.id = s.organization_id
                    WHERE s.user_id = auth.uid()
                      AND s.role = ANY (ARRAY['owner', 'manager']::public.organization_role[])
                    LIMIT 1
               )
           )
      INTO v_wholesaler_id;

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_WHOLESALER';
    END IF;

    IF length(v_phone) < 9 THEN
        RAISE EXCEPTION 'INVALID_PHONE';
    END IF;

    INSERT INTO public.retailer_invites (wholesaler_id, phone, customer_name, created_by, expires_at)
    VALUES (v_wholesaler_id, v_phone, NULLIF(trim(coalesce(p_customer_name, '')), ''), auth.uid(), now() + interval '30 days')
    ON CONFLICT (wholesaler_id, phone) WHERE consumed_at IS NULL
    DO UPDATE SET
        customer_name = EXCLUDED.customer_name,
        created_by = EXCLUDED.created_by,
        created_at = now(),
        expires_at = now() + interval '30 days'
    RETURNING id INTO v_invite_id;

    RETURN v_invite_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_retailer_invite(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_retailer_invite(TEXT, TEXT) TO authenticated;

-- --------------------------------------------------------------------
-- claim_shop_access() — 6-6(거래 관계 연결) 분기를 초대 대조 로직으로 교체.
-- 나머지 6-1~6-5는 154 이후 정의와 동일하다(pg_get_functiondef 기준 패치).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_shop_access(p_shop_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid            UUID := auth.uid();
    v_wholesaler_id  UUID;
    v_business_name  TEXT;
    v_role           TEXT;
    v_name           TEXT;
    v_phone          TEXT;
    v_retailer_id    UUID;
    v_link_status    TEXT;
    v_pristine       BOOLEAN;
    v_relation_exists BOOLEAN;
    v_matched_invite UUID;
    v_new_status     TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;

    -- 6-1. shop_token → 활성 공급사
    SELECT w.id, w.business_name
      INTO v_wholesaler_id, v_business_name
    FROM public.wholesalers w
    WHERE w.shop_token = p_shop_token
      AND w.status = 'active';

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_SHOP_TOKEN';
    END IF;

    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_uid;

    -- 6-2. 슈퍼관리자는 바이어로 전환하지 않는다.
    IF v_role = 'super_admin' THEN
        RAISE EXCEPTION 'NOT_A_BUYER_ACCOUNT';
    END IF;

    -- 6-3. 공급사 기본값으로 만들어진 프로필의 바이어 전환
    IF v_role = 'wholesaler' THEN
        SELECT p.is_verified = false
               AND p.terms_agreed_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM public.wholesalers w WHERE w.profile_id = v_uid)
               AND NOT EXISTS (SELECT 1 FROM public.organization_staff s WHERE s.user_id = v_uid)
          INTO v_pristine
          FROM public.profiles p
         WHERE p.id = v_uid;

        IF NOT COALESCE(v_pristine, false) THEN
            RAISE EXCEPTION 'NOT_A_BUYER_ACCOUNT';
        END IF;

        -- 전화번호가 넘어온 경우에만 중복 가입 대조 (154) — 번호가 없으면 대조 불가
        SELECT COALESCE(
                   NULLIF(u.raw_user_meta_data ->> 'phone_number', ''),
                   NULLIF(u.phone, ''),
                   ''
               )
          INTO v_phone
        FROM auth.users u
        WHERE u.id = v_uid;

        IF v_phone <> '' AND EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.phone = v_phone AND p.id <> v_uid
        ) THEN
            RAISE EXCEPTION 'PHONE_ALREADY_REGISTERED';
        END IF;

        PERFORM set_config('app.supplier_onboarding', 'on', true);

        UPDATE public.profiles
           SET role = 'retailer',
               is_supplier = false,
               is_verified = false,
               updated_at = now()
         WHERE id = v_uid;

        PERFORM set_config('app.supplier_onboarding', 'off', true);

        v_role := 'retailer';
    END IF;

    -- 6-4. 프로필 자동 생성 (카카오 메타데이터만 사용) — 실무에선 6-3이 항상 먼저
    -- 타므로 이 분기는 프로필 행이 아예 없는 특수 상황을 위한 안전망이다.
    IF v_role IS NULL THEN
        SELECT
            COALESCE(
                NULLIF(u.raw_user_meta_data ->> 'name', ''),
                NULLIF(u.raw_user_meta_data ->> 'full_name', ''),
                NULLIF(u.raw_user_meta_data ->> 'preferred_username', ''),
                '카카오 회원'
            ),
            COALESCE(
                NULLIF(u.raw_user_meta_data ->> 'phone_number', ''),
                NULLIF(u.phone, ''),
                ''
            )
          INTO v_name, v_phone
        FROM auth.users u
        WHERE u.id = v_uid;

        IF v_phone <> '' AND EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.phone = v_phone AND p.id <> v_uid
        ) THEN
            RAISE EXCEPTION 'PHONE_ALREADY_REGISTERED';
        END IF;

        INSERT INTO public.profiles (id, role, name, phone, is_supplier, is_verified)
        VALUES (v_uid, 'retailer', COALESCE(v_name, '카카오 회원'), COALESCE(v_phone, ''), false, false)
        ON CONFLICT (id) DO NOTHING;
    END IF;

    -- 이름은 profiles 기준(6-4는 방금 저장했고, 기존 프로필은 이미 있는 값을
    -- 그대로 씀). 전화번호는 다르다 — 6-3은 PII 지연저장 원칙 때문에 phone을
    -- profiles에 저장하지 않는다(role만 바꾼다). v_phone이 이미 채워져
    -- 있으면(6-3/6-4를 막 거쳐온 이번 로그인 — 신규 가입) 카카오가 방금
    -- 넘겨준 그 값을 그대로 초대 대조에 쓴다(저장은 하지 않고 이 함수
    -- 실행 중에만 사용). v_phone이 NULL이면(v_role이 원래부터 'retailer'라
    -- 6-3/6-4를 건너뛴 재방문 손님) record_buyer_consent()가 예전에 저장해둔
    -- profiles.phone을 대신 읽는다. 이 구분이 없으면 모든 신규 가입이
    -- profiles.phone이 아직 비어있어 초대가 있어도 항상 pending_review로
    -- 떨어진다("무마찰 자동승인"이 실제로는 전혀 동작하지 않는 문제였음).
    SELECT p.name INTO v_name FROM public.profiles p WHERE p.id = v_uid;

    IF v_phone IS NULL THEN
        SELECT p.phone INTO v_phone FROM public.profiles p WHERE p.id = v_uid;
    END IF;

    -- 6-5. 식당(retailer) 자동 생성.
    --      상호/배송지는 최초 발주서 작성 화면에서 채워지므로 자리표시자로 둔다.
    SELECT r.id INTO v_retailer_id FROM public.retailers r WHERE r.profile_id = v_uid;

    IF v_retailer_id IS NULL THEN
        INSERT INTO public.retailers (profile_id, restaurant_name, representative_name, delivery_address)
        VALUES (
            v_uid,
            COALESCE(NULLIF(v_name, ''), '카카오 회원'),
            COALESCE(NULLIF(v_name, ''), '카카오 회원'),
            ''
        )
        RETURNING id INTO v_retailer_id;
    END IF;

    -- 6-6. 거래 관계 연결.
    --      이미 관계가 있으면(다른 공급사와 먼저 거래를 텄던 재방문 손님 등)
    --      건드리지 않는다 — 초대 대조는 "처음 만들 때"만 한다.
    SELECT EXISTS (
        SELECT 1 FROM public.wholesaler_retailers wr
        WHERE wr.wholesaler_id = v_wholesaler_id AND wr.retailer_id = v_retailer_id
    ) INTO v_relation_exists;

    IF NOT v_relation_exists THEN
        v_matched_invite := NULL;

        IF v_phone IS NOT NULL AND v_phone <> '' THEN
            SELECT id INTO v_matched_invite
            FROM public.retailer_invites
            WHERE wholesaler_id = v_wholesaler_id
              AND phone = v_phone
              AND consumed_at IS NULL
              AND expires_at > now()
            ORDER BY created_at DESC
            LIMIT 1;
        END IF;

        v_new_status := CASE WHEN v_matched_invite IS NOT NULL THEN 'active' ELSE 'pending_review' END;

        INSERT INTO public.wholesaler_retailers (wholesaler_id, retailer_id, status)
        VALUES (v_wholesaler_id, v_retailer_id, v_new_status)
        ON CONFLICT (wholesaler_id, retailer_id) DO NOTHING;

        IF v_matched_invite IS NOT NULL THEN
            UPDATE public.retailer_invites
               SET consumed_at = now(), consumed_retailer_id = v_retailer_id
             WHERE id = v_matched_invite;
        END IF;
    END IF;

    SELECT wr.status INTO v_link_status
    FROM public.wholesaler_retailers wr
    WHERE wr.wholesaler_id = v_wholesaler_id
      AND wr.retailer_id = v_retailer_id;

    RETURN jsonb_build_object(
        'retailer_id', v_retailer_id,
        'wholesaler_id', v_wholesaler_id,
        'business_name', v_business_name,
        'is_linked', v_link_status = 'active',
        'status', v_link_status
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_shop_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_shop_access(UUID) TO authenticated;
