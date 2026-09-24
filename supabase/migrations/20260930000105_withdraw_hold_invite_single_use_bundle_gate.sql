-- ====================================================================
-- 가입·상품 점검 후속 (2026-09-24, 사장님 결정 3건)
--
-- (1) 고객(식당) 탈퇴는 미수금이 남아 있으면 보류 — 공급사 탈퇴(OUTSTANDING_BALANCE_EXISTS)와 동일.
--     탈퇴 즉시 이름·전화를 익명화하면 공급사가 미수금을 받을 연락처를 잃는다.
--     이용약관에 근거 조항("미정산 채무가 있는 경우 탈퇴 보류")은 사장님이 정비.
--
-- (2) 직원 초대 링크는 1회용 — 이미 사용된(used_count > 0) 링크는 미리보기·수락 모두 무효.
--     지금까진 만료(7일)·취소 전까지 누구나 몇 번이든 쓸 수 있어 직원이 받은 링크를
--     남에게 넘기면 그 사람도 가입됐다. 여러 명은 링크를 여러 개 만든다.
--
-- (3) 세트(BOM) 지정(save_product_bundle)·해제(delete_product_bundle)는 owner/manager만.
--     상품 마스터를 새로 만들고 지우는 일인데 역할 검사가 없어 직원(staff)도 할 수 있었다
--     (상품 INSERT RLS는 owner/manager 전용인데 SECURITY DEFINER RPC가 우회했음).
--     조립(assemble)·해체(disassemble)는 창고 작업이라 직원 허용 유지.
--     두 함수 본문은 로컬 DB pg_get_functiondef 결과에 게이트 4줄만 끼워 넣은 것.
--
-- 로컬 검증: scripts/db-test-signup-and-accounts.sql, scripts/db-test-product-management.sql
-- ====================================================================

-- --------------------------------------------------------------------
-- (1) withdraw_retailer_account — 미수금 있으면 거부
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.withdraw_retailer_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare
    v_uid         uuid := auth.uid();
    v_role        text;
    v_retailer_id uuid;
    v_outstanding numeric;
begin
    if v_uid is null then
        raise exception 'AUTH_REQUIRED';
    end if;

    select role into v_role from public.profiles where id = v_uid;
    if v_role <> 'retailer' then
        raise exception 'NOT_A_RETAILER_ACCOUNT';
    end if;

    select id into v_retailer_id from public.retailers where profile_id = v_uid;
    if v_retailer_id is null then
        raise exception 'RETAILER_NOT_FOUND';
    end if;

    -- 미정산 외상이 남아 있으면 탈퇴 보류(2026-09-24 사장님 결정, 공급사 탈퇴와 동일 규칙).
    select coalesce(sum(outstanding_balance), 0) into v_outstanding
      from public.wholesaler_retailers
     where retailer_id = v_retailer_id;

    if v_outstanding > 0 then
        raise exception 'OUTSTANDING_BALANCE_EXISTS';
    end if;

    update public.profiles
       set name = '탈퇴한 회원',
           phone = '',
           withdrawn_at = now(),
           updated_at = now()
     where id = v_uid;

    update public.retailers
       set restaurant_name = '탈퇴한 회원',
           representative_name = '탈퇴한 회원',
           business_number = null,
           delivery_address = '',
           delivery_address_detail = null,
           updated_at = now()
     where id = v_retailer_id;

    return jsonb_build_object('retailer_id', v_retailer_id, 'withdrawn', true);
end;
$$;

-- --------------------------------------------------------------------
-- (2) 초대 링크 1회용
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_staff_invite_info(p_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    select jsonb_build_object(
        'valid', true,
        'organization_name', o.name
    )
    from public.organization_staff_invites i
    join public.organizations o on o.id = i.organization_id
    where i.token = p_token
      and i.revoked_at is null
      and i.expires_at > now()
      and i.used_count = 0;
$$;

CREATE OR REPLACE FUNCTION public.claim_organization_staff_invite(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare
    v_uid    uuid := auth.uid();
    v_invite public.organization_staff_invites%rowtype;
    v_role   text;
begin
    if v_uid is null then
        raise exception 'AUTH_REQUIRED';
    end if;

    -- 행을 잠가 같은 링크를 두 사람이 동시에 눌러도 한 명만 들어온다.
    select * into v_invite
      from public.organization_staff_invites
     where token = p_token
       and revoked_at is null
       and expires_at > now()
       and used_count = 0
     for update;

    if v_invite.id is null then
        raise exception 'INVALID_OR_EXPIRED_INVITE';
    end if;

    select role into v_role from public.profiles where id = v_uid;
    if v_role = 'retailer' then
        raise exception 'RETAILER_CANNOT_JOIN_STAFF';
    end if;

    if exists (select 1 from public.organization_staff where user_id = v_uid) then
        raise exception 'ALREADY_STAFF_ELSEWHERE';
    end if;

    if exists (select 1 from public.wholesalers where profile_id = v_uid) then
        raise exception 'WHOLESALER_OWNER_CANNOT_JOIN_AS_STAFF';
    end if;

    begin
        insert into public.organization_staff (organization_id, user_id, role, invited_by)
        values (v_invite.organization_id, v_uid, v_invite.role, v_invite.created_by);
    exception
        when unique_violation then
            raise exception 'ALREADY_STAFF_ELSEWHERE';
    end;

    update public.organization_staff_invites
       set used_count = used_count + 1
     where id = v_invite.id;

    return jsonb_build_object('organization_id', v_invite.organization_id, 'role', v_invite.role);
end;
$$;

-- --------------------------------------------------------------------
-- (3) 세트 지정·해제는 owner/manager만
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_product_bundle(p_items jsonb, p_bundle_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_base_price numeric DEFAULT NULL::numeric, p_bundle_code text DEFAULT NULL::text, p_memo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_bundle        public.product_bundles%ROWTYPE;
    v_product_id    UUID;
    v_bundle_id     UUID;
    v_code          TEXT;
    v_item          RECORD;
    v_component     public.products%ROWTYPE;
    v_category      TEXT;
    v_origin        TEXT;
    v_created       BOOLEAN := false;
    v_count         INTEGER;
    v_manual_stock  NUMERIC(10, 3);
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;
    -- 세트 지정·해제는 상품 마스터를 만들고 지우는 일 — owner/manager만 (20260930000105).
    IF NOT public.can_manage_wholesaler(v_wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'BUNDLE_HAS_NO_ITEMS';
    END IF;

    -- ① 대상 세트/상품 결정 -------------------------------------------------
    IF p_bundle_id IS NOT NULL THEN
        SELECT * INTO v_bundle FROM public.product_bundles WHERE id = p_bundle_id;

        IF v_bundle.id IS NULL OR v_bundle.wholesaler_id <> v_wholesaler_id THEN
            RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
        END IF;

        v_bundle_id  := v_bundle.id;
        v_product_id := v_bundle.product_id;

    ELSIF p_product_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.product_bundles WHERE product_id = p_product_id) THEN
            RAISE EXCEPTION 'ALREADY_A_BUNDLE';
        END IF;

        SELECT stock_quantity INTO v_manual_stock
        FROM public.products
        WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id AND archived_at IS NULL;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
        END IF;

        -- kg으로 쌓인 재고와 세트 개수가 한 컬럼에서 뒤섞인다 (설계 결정 8번).
        IF public.product_has_stock_history(p_product_id) THEN
            RAISE EXCEPTION 'PRODUCT_HAS_STOCK_HISTORY';
        END IF;

        -- 수동 재고가 남아 있으면 첫 제작 때 기초재고로 편입돼 "박스 없는 세트"가 된다
        -- (2026-09-24 점검 2). 세트는 박스로만 존재해야 하므로 0으로 만든 뒤 지정하게 한다.
        IF COALESCE(v_manual_stock, 0) <> 0 THEN
            RAISE EXCEPTION 'PRODUCT_HAS_MANUAL_STOCK:%', v_manual_stock;
        END IF;

        -- 남의 세트의 구성품으로 이미 쓰이고 있으면 중첩이 된다 (설계 결정 6번).
        IF EXISTS (SELECT 1 FROM public.product_bundle_items WHERE component_product_id = p_product_id) THEN
            RAISE EXCEPTION 'COMPONENT_CANNOT_BE_BUNDLE';
        END IF;

        v_product_id := p_product_id;

    ELSE
        IF COALESCE(btrim(p_name), '') = '' THEN
            RAISE EXCEPTION 'NAME_REQUIRED';
        END IF;

        -- 축종·원산지는 구성품에서 물려받는다. 섞여 있으면 '혼합'.
        SELECT
            MIN(p.category),
            CASE WHEN COUNT(DISTINCT p.origin) = 1 THEN MIN(p.origin) ELSE '혼합' END
        INTO v_category, v_origin
        FROM jsonb_array_elements(p_items) e
        JOIN public.products p ON p.id = (e ->> 'product_id')::uuid
        WHERE p.wholesaler_id = v_wholesaler_id;

        IF v_category IS NULL THEN
            RAISE EXCEPTION 'COMPONENT_NOT_FOUND';
        END IF;

        INSERT INTO public.products (
            wholesaler_id, name, category, origin, base_price, unit,
            stock_quantity, is_active, description
        ) VALUES (
            v_wholesaler_id, btrim(p_name), v_category, v_origin,
            GREATEST(COALESCE(p_base_price, 0), 0), '세트',
            0,
            -- 자동 생성 상품과 같은 정책: 가격을 넣고 직접 켜야 노출된다(12단계).
            COALESCE(p_base_price, 0) > 0,
            NULL
        )
        RETURNING id INTO v_product_id;

        v_created := true;
    END IF;

    -- ② 자체 상품코드 ------------------------------------------------------
    v_code := upper(btrim(COALESCE(p_bundle_code, '')));

    IF v_code = '' THEN
        IF v_bundle.bundle_code IS NOT NULL THEN
            v_code := v_bundle.bundle_code;
        ELSE
            -- 업체 안에서 1번부터 센다. 동시 발급은 자문 잠금으로 막는다.
            PERFORM pg_advisory_xact_lock(hashtext('bundle_code:' || v_wholesaler_id::text));

            SELECT COUNT(*) + 1 INTO v_count
            FROM public.product_bundles WHERE wholesaler_id = v_wholesaler_id;

            v_code := 'BND-' || lpad(v_count::text, 4, '0');
        END IF;
    END IF;

    -- ③ 세트 정의 저장 -----------------------------------------------------
    IF v_bundle_id IS NULL THEN
        INSERT INTO public.product_bundles (wholesaler_id, product_id, bundle_code, memo, created_by)
        VALUES (v_wholesaler_id, v_product_id, v_code, NULLIF(btrim(COALESCE(p_memo, '')), ''), auth.uid())
        RETURNING id INTO v_bundle_id;
    ELSE
        UPDATE public.product_bundles
        SET bundle_code = v_code,
            memo = NULLIF(btrim(COALESCE(p_memo, '')), '')
        WHERE id = v_bundle_id;
    END IF;

    -- ④ 세트 상품의 단위는 '세트'로 맞춘다 (설계 결정 3번) ------------------
    UPDATE public.products SET unit = '세트' WHERE id = v_product_id AND unit <> '세트';

    -- ⑤ 구성품 교체 --------------------------------------------------------
    DELETE FROM public.product_bundle_items
    WHERE bundle_id = v_bundle_id
      AND component_product_id NOT IN (
          SELECT (e ->> 'product_id')::uuid FROM jsonb_array_elements(p_items) e
      );

    FOR v_item IN
        SELECT
            (e ->> 'product_id')::uuid AS product_id,
            COALESCE((e ->> 'quantity')::numeric, 0) AS quantity,
            (ordinality - 1)::int AS sort_order
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ordinality)
    LOOP
        IF v_item.quantity <= 0 THEN
            RAISE EXCEPTION 'INVALID_COMPONENT_QUANTITY';
        END IF;

        IF v_item.product_id = v_product_id THEN
            RAISE EXCEPTION 'SELF_COMPONENT';
        END IF;

        SELECT * INTO v_component FROM public.products WHERE id = v_item.product_id;

        IF v_component.id IS NULL
           OR v_component.wholesaler_id <> v_wholesaler_id
           OR v_component.archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'COMPONENT_NOT_FOUND';
        END IF;

        -- 세트를 구성품으로 넣는 중첩 세트는 금지 (설계 결정 6번).
        IF EXISTS (SELECT 1 FROM public.product_bundles WHERE product_id = v_item.product_id) THEN
            RAISE EXCEPTION 'NESTED_BUNDLE:%', v_component.name;
        END IF;

        INSERT INTO public.product_bundle_items (bundle_id, component_product_id, quantity, sort_order)
        VALUES (v_bundle_id, v_item.product_id, v_item.quantity, v_item.sort_order)
        ON CONFLICT (bundle_id, component_product_id) DO UPDATE
        SET quantity = EXCLUDED.quantity, sort_order = EXCLUDED.sort_order;
    END LOOP;

    RETURN jsonb_build_object(
        'bundle_id',    v_bundle_id,
        'product_id',   v_product_id,
        'bundle_code',  v_code,
        'created',      v_created,
        'buildable',    public.bundle_buildable_sets(v_bundle_id)
    );
END;
$function$

;

CREATE OR REPLACE FUNCTION public.delete_product_bundle(p_bundle_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_bundle        public.product_bundles%ROWTYPE;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;
    -- 세트 지정·해제는 상품 마스터를 만들고 지우는 일 — owner/manager만 (20260930000105).
    IF NOT public.can_manage_wholesaler(v_wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    SELECT * INTO v_bundle FROM public.product_bundles WHERE id = p_bundle_id;

    IF v_bundle.id IS NULL OR v_bundle.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
    END IF;

    IF EXISTS (SELECT 1 FROM public.bundle_assemblies WHERE bundle_id = p_bundle_id) THEN
        RAISE EXCEPTION 'BUNDLE_HAS_ASSEMBLIES';
    END IF;

    DELETE FROM public.product_bundles WHERE id = p_bundle_id;

    RETURN jsonb_build_object('deleted', true, 'product_id', v_bundle.product_id);
END;
$function$

;
