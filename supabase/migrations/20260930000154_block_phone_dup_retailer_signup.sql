-- ====================================================================
-- 같은 전화번호로 손님(retailer) 계정 중복 가입 차단
--
-- 문제: claim_shop_access()는 카카오 계정(auth.uid())만 보고 손님 프로필을
--   새로 만들었다. 카카오는 계정 단위라서, 같은 사람이 부계정으로 로그인해
--   자기 자신의 미니샵에 손님으로 가입하거나(자기 상대 거래 조작), 같은
--   전화번호로 손님 계정을 여러 개 만드는 걸 막을 방법이 없었다.
--
-- 수정: 카카오가 전화번호를 넘겨준 경우(v_phone <> '')에 한해, 그 번호가
--   이미 다른 profiles 행(공급사든 손님이든 role 무관)에 있으면 가입을
--   거부한다. 전화번호가 비어 있는 계정(카카오 동의 항목에 따라 흔함)은
--   대조 대상이 없으므로 그대로 통과 — 이 체크가 전부를 막지는 못하지만,
--   번호가 남아있는 경우는 막는다.
--
-- 주의: handle_new_user() 트리거가 auth.users INSERT 즉시 role='wholesaler'인
--   pristine profiles 행을 만들어두기 때문에, 실제 신규 바이어는 거의 항상
--   6-3(공급사 기본값 → 바이어 전환) 분기를 타지 6-4(v_role IS NULL)는
--   타지 않는다. 그래서 체크를 6-3에도 추가한다 — 거기서 v_phone을 한 번도
--   읽지 않았던 것도 이번에 고쳤다(기존엔 6-4가 사실상 죽은 분기였다).
--   6-4에도 동일 체크를 남겨 그 분기가 쓰일 경우(예: 프로필 행이 없는
--   특수 상황)를 대비한다.
--
-- 영향 없음: 기존 손님이 다른 공급사 미니샵에 추가로 가입하는 경로(이미
--   retailer role이라 6-3/6-4를 둘 다 건너뛰고 6-5/6-6만 타는 경우)는 이
--   체크를 거치지 않아 그대로 허용된다.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.claim_shop_access(p_shop_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid           UUID := auth.uid();
    v_wholesaler_id UUID;
    v_business_name TEXT;
    v_role          TEXT;
    v_name          TEXT;
    v_phone         TEXT;
    v_retailer_id   UUID;
    v_link_status   TEXT;
    v_pristine      BOOLEAN;
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

        -- 전화번호가 넘어온 경우에만 중복 가입 대조 (번호가 없으면 대조 불가)
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

    -- 6-4. 프로필 자동 생성 (카카오 메타데이터만 사용)
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

        -- 전화번호가 넘어온 경우에만 중복 가입 대조 (번호가 없으면 대조 불가)
        IF v_phone <> '' AND EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.phone = v_phone AND p.id <> v_uid
        ) THEN
            RAISE EXCEPTION 'PHONE_ALREADY_REGISTERED';
        END IF;

        INSERT INTO public.profiles (id, role, name, phone, is_supplier, is_verified)
        VALUES (v_uid, 'retailer', COALESCE(v_name, '카카오 회원'), COALESCE(v_phone, ''), false, false)
        ON CONFLICT (id) DO NOTHING;
    END IF;

    SELECT p.name INTO v_name FROM public.profiles p WHERE p.id = v_uid;

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
    --      이미 'blocked' 로 차단된 거래처는 링크 재클릭으로 부활하지 않는다.
    INSERT INTO public.wholesaler_retailers (wholesaler_id, retailer_id, status)
    VALUES (v_wholesaler_id, v_retailer_id, 'active')
    ON CONFLICT (wholesaler_id, retailer_id) DO NOTHING;

    SELECT wr.status INTO v_link_status
    FROM public.wholesaler_retailers wr
    WHERE wr.wholesaler_id = v_wholesaler_id
      AND wr.retailer_id = v_retailer_id;

    RETURN jsonb_build_object(
        'retailer_id', v_retailer_id,
        'wholesaler_id', v_wholesaler_id,
        'business_name', v_business_name,
        'is_linked', v_link_status = 'active'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_shop_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_shop_access(UUID) TO authenticated;
