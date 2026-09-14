-- ====================================================================
-- 신규 가입자 개인정보(이름/전화번호) 저장을 서비스 자체 동의 시점까지 지연
--
-- 문제:
--   handle_new_user() 트리거가 auth.users INSERT 직후 카카오가 제공한
--   실제 이름/전화번호를 profiles에 즉시 복사해왔다. 이 시점은 사용자가
--   이 서비스의 이용약관/개인정보 수집·이용에 동의(공급사는
--   complete_supplier_signup 호출 시점)하기 전이라, 동의 없이 개인정보가
--   저장되는 구간이 생겼다. 온보딩을 완료하지 않고 이탈해도 그 값은
--   동의 없이 그대로 남는다.
--
-- 수정:
--   트리거는 이제 실제 카카오 이름/전화 대신 빈 문자열(placeholder)만
--   채운다. 실제 값은 여전히 complete_supplier_signup()이 동의 체크박스
--   통과 직후 기록한다(그 함수는 변경 없음).
--
--   화면 표시 영향 없음: resolveDisplayName()(lib/auth/display-name.ts)이
--   profiles.name이 공백이면 세션의 카카오 닉네임(user_metadata)으로
--   자동 폴백하도록 이미 설계되어 있다.
--
-- 영향 범위:
--   공급사뿐 아니라 바이어(claim_shop_access 6-4/6-5)도 이 트리거를
--   거치므로 동일하게 적용된다. 바이어 쪽은 아직 별도 동의 체크박스
--   화면이 없어 이 수정만으로 완전히 해소되지는 않는다 — 별도 후속
--   과제로 남겨둔다(docs/supplier-signup-pii-consent.md 참고).
--
-- 이 마이그레이션은 함수 재정의(CREATE OR REPLACE)뿐이라 멱등하다.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 카카오가 제공한 실제 이름/전화번호는 여기서 저장하지 않는다.
    -- (이 시점은 아직 이 서비스 자체의 약관/개인정보 동의 이전이다)
    -- 실제 값은 complete_supplier_signup()이 동의 확인 직후 채운다.
    INSERT INTO public.profiles (id, role, name, phone, is_supplier, is_verified)
    VALUES (NEW.id, 'wholesaler', '', '', true, false)
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;

-- ====================================================================
-- claim_shop_access() 동반 수정 (바이어 가입 경로)
--
-- 위 트리거 변경으로 신규 계정의 profiles.name이 이제 항상 빈 문자열('')로
-- 시작한다. 이 함수의 기존 COALESCE(v_name, '카카오 회원')는 NULL만 대체하고
-- 빈 문자열은 그대로 통과시키므로, 그대로 두면 신규 바이어의
-- retailers.restaurant_name / representative_name이 빈 문자열로 저장되는
-- 회귀가 생긴다. NULLIF(v_name, '')로 감싸 빈 문자열도 '미대체 값'으로
-- 취급하도록 두 지점만 고친다. 그 외 로직은 20260914000000 정의와 동일.
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
