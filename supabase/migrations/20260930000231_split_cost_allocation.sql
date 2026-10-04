-- 쪼개기 원가 배분 + 수율 손실 인식 (2026-10-04, 사장님 결정)
--
-- 지금까지 쪼개기는 지육의 매입 원가를 부위 박스로 넘기지 않았다. 지육은 잔량 0이 돼 매출원가에 한 번도 잡히지 않았고 부위 박스는 원가가 비어
-- 부위를 팔 때마다 "원가 미입력"으로 분리됐다. 손익이 매출 시점에 원가를 같이 잡도록, 쪼개는 순간 원가를 부위 박스와 손실로 나눈다.
--
--  · 지육 원가 = 부위 원가의 합 + 손실 원가 (항상 일치). 손실 원가 = 손실 무게 × 지육 kg 단가.
--  · 나머지 원가는 "부위 무게 × 부위 가격" 비율로 나눈다(판매가치 비례). 부위 가격은 줄에 적은 값(현장이 사무실에 물어 적음), 없으면 그 상품의 판매 기본가.
--    둘 다 없어도 쪼개기는 막지 않는다(대표 결정) — 그 줄은 지육 kg 단가를 기준으로 삼고 price_fallback에 줄 번호를 돌려준다.
--    지육 단가를 모르는 박스는 예전처럼 배분하지 않는다.
--  · 수율 손실은 장부 LOSS + box_disposals(사유 YIELD, 손실 금액)로 남겨 재고 조정·손실 탭에 보인다.
--    부모 장부는 SPLIT_OUT(부위로 나간 합계) + LOSS(손실)이 되어 합이 예전 SPLIT_OUT(전량)과 같다.
--  · 부위 박스 단가는 지육 원가를 나눈 값이라 매입 정산(목록·합계)은 자식을 세지 않는다. 실제 지출은 부모 한 곳.
--  · 이미 쪼갠 과거 박스는 건드리지 않는다.
--
-- 함수 본문은 로컬 DB의 pg_get_functiondef 기준으로 패치했다(079 방식).

ALTER TABLE public.box_disposals DROP CONSTRAINT IF EXISTS box_disposals_reason_code_check;
ALTER TABLE public.box_disposals
    ADD CONSTRAINT box_disposals_reason_code_check
    CHECK (reason_code IN ('EXPIRED', 'DAMAGE', 'SPOILED', 'OTHER', 'SHRINKAGE', 'YIELD'));

CREATE OR REPLACE FUNCTION public.split_inbound_scan(p_scan_id uuid, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
    v_wholesaler_id uuid;
    v_parent        public.inbound_scans%rowtype;
    v_line          jsonb;
    v_idx           integer := 0;
    v_weight        numeric(10, 3);
    v_product_id    uuid;
    v_product       public.products%rowtype;
    v_resolved      jsonb;
    v_total         numeric(10, 3) := 0;
    v_loss          numeric(10, 3);
    v_child_id      uuid;
    v_children      uuid[] := '{}';
    v_line_products uuid[] := '{}';
    v_line_weights  numeric[] := '{}';
    -- 원가 배분(231): 지육(부모) 매입 원가를 부위 박스(자식)와 손실로 나눈다. 부모 단가를 모르면 배분하지 않는다(예전과 같음).
    v_alloc         boolean;
    v_parent_price  numeric;
    v_cost          numeric;
    v_loss_ideal    numeric;
    v_parts_cost    numeric;
    v_price         numeric;
    v_sum_value     numeric := 0;
    v_fallback      integer[] := '{}';
    v_line_prices   numeric[] := '{}';
    v_child_prices  numeric[] := '{}';
    v_sum_amount    numeric := 0;
    v_loss_amount   numeric;
    v_disposal_id   uuid := gen_random_uuid();
    v_created_names text[] := '{}';
    v_product_ids   uuid[] := '{}';
    v_pid           uuid;
    i               integer;
begin
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    if v_wholesaler_id is null then
        raise exception 'NOT_A_SUPPLIER';
    end if;

    if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
        raise exception 'NO_SPLIT_LINES';
    end if;

    if jsonb_array_length(p_lines) > 30 then
        raise exception 'TOO_MANY_SPLIT_LINES';
    end if;

    -- 박스를 먼저 잠근다(잠금 순서: 박스 → 상품, 099 설계 결정).
    select * into v_parent
      from public.inbound_scans
     where id = p_scan_id and wholesaler_id = v_wholesaler_id
       for update;

    if v_parent.id is null then
        raise exception 'SCAN_NOT_FOUND';
    end if;

    if v_parent.split_at is not null then
        raise exception 'ALREADY_SPLIT';
    end if;

    if v_parent.status <> 'NORMAL' or v_parent.product_id is null then
        raise exception 'SCAN_NOT_SPLITTABLE';
    end if;

    if v_parent.remaining_weight <= 0 then
        raise exception 'NOTHING_TO_SPLIT';
    end if;

    v_parent_price := v_parent.purchase_unit_price;
    v_alloc := v_parent_price is not null;

    -- 줄 검증 + 상품 확정(부위만 온 줄은 여기서 상품을 찾거나 만든다. 어느 줄이든 실패하면 전부 롤백).
    for v_line in select * from jsonb_array_elements(p_lines) loop
        v_idx := v_idx + 1;

        begin
            v_weight := (v_line ->> 'weight')::numeric;
            v_product_id := nullif(v_line ->> 'product_id', '')::uuid;
        exception when others then
            raise exception 'INVALID_SPLIT_LINE:%', v_idx;
        end;

        if v_weight is null or v_weight <= 0 then
            raise exception 'INVALID_SPLIT_LINE:%', v_idx;
        end if;

        if v_product_id is null then
            if nullif(btrim(coalesce(v_line ->> 'part', '')), '') is null then
                raise exception 'INVALID_SPLIT_LINE:%', v_idx;
            end if;

            v_resolved := public.split_resolve_product(v_wholesaler_id, v_parent, v_line ->> 'part');
            v_product_id := (v_resolved ->> 'product_id')::uuid;

            if (v_resolved ->> 'created')::boolean and not (v_resolved ->> 'name' = any (v_created_names)) then
                v_created_names := v_created_names || (v_resolved ->> 'name');
            end if;
        end if;

        select * into v_product from public.products where id = v_product_id and wholesaler_id = v_wholesaler_id;

        if v_product.id is null then
            raise exception 'PRODUCT_NOT_FOUND:%', v_idx;
        end if;

        if v_product.unit is distinct from v_parent.unit then
            raise exception 'PRODUCT_UNIT_MISMATCH:%', v_idx;
        end if;

        -- 부위 가격(원가를 나누는 기준): 줄에 적은 값, 없으면 그 부위 상품의 판매 기본가. 둘 다 없어도 쪼개기를 막지 않는다 —
        -- 그 줄은 지육 kg 단가를 기준으로 삼고(무게 비례에 가깝다) 어느 줄인지 돌려줘서 화면이 사무실에 가격을 물어보라고 알린다.
        if v_alloc then
            begin
                v_price := nullif(v_line ->> 'unit_price', '')::numeric;
            exception when others then
                raise exception 'INVALID_SPLIT_LINE:%', v_idx;
            end;

            if v_price is null or v_price <= 0 then
                v_price := v_product.base_price;
            end if;

            if v_price is null or v_price <= 0 then
                v_price := v_parent_price;
                v_fallback := v_fallback || v_idx;
            end if;

            v_line_prices := v_line_prices || v_price;
            v_sum_value := v_sum_value + v_weight * v_price;
        end if;

        v_line_products := v_line_products || v_product_id;
        v_line_weights := v_line_weights || v_weight;
        v_total := v_total + v_weight;
    end loop;

    if v_total > v_parent.remaining_weight then
        raise exception 'CHILDREN_EXCEED_PARENT:%:%', v_total, v_parent.remaining_weight;
    end if;

    v_loss := v_parent.remaining_weight - v_total;

    -- 원가 배분(231). 지육 원가 = 부위 원가의 합 + 손실 원가가 항상 맞는다.
    --  · 손실 원가 = 손실 무게 × 지육 kg 단가. 나머지를 부위 가격 × 무게 비율로 나눈다(판매가치 비례).
    --  · 부위 kg 단가는 소수 둘째 자리까지라 원 단위로 반올림한 박스 금액과 어긋나는 몇 원은 손실이 흡수한다.
    if v_alloc then
        v_cost := round(v_parent.remaining_weight * v_parent_price, 0);
        v_loss_ideal := round(v_loss * v_parent_price, 0);
        v_parts_cost := v_cost - v_loss_ideal;

        for i in 1 .. array_length(v_line_products, 1) loop
            v_child_prices := v_child_prices
                || round(coalesce(v_parts_cost * (v_line_weights[i] * v_line_prices[i] / nullif(v_sum_value, 0)), 0) / v_line_weights[i], 2);
            v_sum_amount := v_sum_amount + round(v_line_weights[i] * v_child_prices[i], 0);
        end loop;

        v_loss_amount := v_cost - v_sum_amount;
    end if;

    -- 기초재고 이관은 첫 원장 행 전에(ensure_opening_balance 규칙). 관련 상품 전부.
    select coalesce(array_agg(distinct x), '{}') into v_product_ids
      from (select v_parent.product_id as x union select unnest(v_line_products)) t;

    foreach v_pid in array v_product_ids loop
        perform public.ensure_opening_balance(v_pid);
    end loop;

    -- 부모: 남은 전량을 내보낸다. 부위로 나간 만큼은 SPLIT_OUT, 손실(뼈·지방 등)은 LOSS로 따로 남겨 손실 탭에 보이게 한다(231).
    insert into public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, reason, created_by
    ) values (
        v_wholesaler_id, v_parent.product_id, v_parent.id, -v_total,
        'SPLIT_OUT', 'inbound_scan', v_parent.id, '쪼개기', auth.uid()
    );

    if v_loss > 0 then
        insert into public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) values (
            v_wholesaler_id, v_parent.product_id, v_parent.id, -v_loss,
            'LOSS', 'manual', v_disposal_id, '쪼개기 수율 손실', auth.uid()
        );

        insert into public.box_disposals (
            id, wholesaler_id, inbound_scan_id, product_id, trace_no, product_name,
            reason_code, note, weight, before_remaining, after_remaining, unit_price, loss_amount, disposed_by
        ) values (
            v_disposal_id, v_wholesaler_id, v_parent.id, v_parent.product_id, v_parent.trace_no,
            (select p.name from public.products p where p.id = v_parent.product_id),
            'YIELD', '쪼개기 수율 손실(뼈·지방 등)', v_loss, v_parent.remaining_weight, 0,
            v_parent_price, case when v_alloc then v_loss_amount end, auth.uid()
        );
    end if;

    update public.inbound_scans
       set remaining_weight = 0, split_at = now(), split_loss = v_loss
     where id = v_parent.id;

    -- 자식: 이력번호·박스 정보는 부모 것, 중량·상품만 줄마다. 꼬리표는 삽입 트리거가 번호+상품으로 채운다.
    -- 부위 박스 단가는 지육 원가를 나눈 값이다(231). 실제 지출은 부모 박스 한 곳이라 매입 정산은 자식을 세지 않는다.
    for i in 1 .. array_length(v_line_products, 1) loop
        insert into public.inbound_scans (
            wholesaler_id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight,
            purchase_unit_price, purchase_supplier,
            best_before, storage_location, storage_location_photo_path, scanned_by,
            parent_scan_id, memo
        ) values (
            v_wholesaler_id, v_parent.trace_no, v_line_products[i], v_line_weights[i], v_parent.unit, 'MANUAL', 'NORMAL', v_line_weights[i],
            case when v_alloc then v_child_prices[i] end, v_parent.purchase_supplier,
            v_parent.best_before, v_parent.storage_location, v_parent.storage_location_photo_path, auth.uid(),
            v_parent.id, '쪼개기'
        ) returning id into v_child_id;

        insert into public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) values (
            v_wholesaler_id, v_line_products[i], v_child_id, v_line_weights[i],
            'SPLIT_IN', 'inbound_scan', v_parent.id, '쪼개기', auth.uid()
        );

        v_children := v_children || v_child_id;
    end loop;

    -- 재고 캐시는 마지막에, 상품 id 순으로.
    foreach v_pid in array (select array_agg(x order by x) from unnest(v_product_ids) x) loop
        perform public.recalc_product_stock(v_pid);
    end loop;

    return jsonb_build_object(
        'parent_id', v_parent.id,
        'children', to_jsonb(v_children),
        'children_weight', v_total,
        'loss', v_loss,
        'loss_amount', v_loss_amount,
        'price_fallback', to_jsonb(v_fallback),
        'created_products', to_jsonb(v_created_names)
    );
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_inbound_purchases(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_supplier text DEFAULT NULL::text, p_only_gap boolean DEFAULT false, p_limit integer DEFAULT 200)
 RETURNS TABLE(scan_id uuid, scanned_at timestamp with time zone, trace_no text, product_id uuid, product_name text, labeled_weight numeric, actual_weight numeric, weight_variance numeric, variance_ratio numeric, unit_price numeric, purchase_amount numeric, purchase_supplier text, status text, scanned_by text, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT
        s.id,
        s.created_at,
        s.trace_no,
        s.product_id,
        p.name,
        s.labeled_weight,
        s.weight,
        s.weight_variance,
        CASE
            WHEN s.labeled_weight IS NULL OR s.labeled_weight = 0 THEN NULL
            ELSE ROUND(s.weight_variance / s.labeled_weight, 4)
        END,
        s.purchase_unit_price,
        s.purchase_amount,
        s.purchase_supplier,
        s.status,
        pr.name,
        s.updated_at
    FROM public.inbound_scans s
    LEFT JOIN public.products p  ON p.id = s.product_id
    LEFT JOIN public.profiles pr ON pr.id = s.scanned_by
    WHERE s.wholesaler_id = public.resolve_current_wholesaler_id()
      AND (SELECT public.can_view_cost(public.resolve_current_wholesaler_id()))
      AND public.feature_effective(public.resolve_current_wholesaler_id(), 'accounting_purchases')
      AND s.status <> 'VOIDED'
      -- 쪼개서 생긴 부위 박스의 단가는 지육 원가를 나눈 것이다(231). 실제 지출은 부모 박스 한 곳에서만 센다.
      AND s.parent_scan_id IS NULL
      AND (p_from IS NULL OR s.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR s.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR s.product_id = p_product_id)
      AND (
            NULLIF(btrim(COALESCE(p_supplier, '')), '') IS NULL
         OR s.purchase_supplier ILIKE '%' || btrim(p_supplier) || '%'
      )
      AND (
            NOT p_only_gap
         OR (
              s.labeled_weight IS NOT NULL
              AND s.labeled_weight > 0
              AND abs(s.weight_variance / s.labeled_weight) > public.inbound_weight_tolerance()
            )
      )
    ORDER BY s.created_at DESC
    LIMIT LEAST(COALESCE(p_limit, 200), 1000);
$function$;

CREATE OR REPLACE FUNCTION public.summarize_inbound_purchases(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_supplier text DEFAULT NULL::text)
 RETURNS TABLE(box_count integer, labeled_total numeric, actual_total numeric, variance_total numeric, purchase_total numeric, unpriced_count integer, over_gap_count integer, variance_amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT
        COUNT(*)::INTEGER,
        COALESCE(SUM(s.labeled_weight), 0),
        COALESCE(SUM(s.weight), 0),
        COALESCE(SUM(s.weight_variance), 0),
        COALESCE(SUM(s.purchase_amount), 0),
        COUNT(*) FILTER (WHERE s.purchase_unit_price IS NULL)::INTEGER,
        COUNT(*) FILTER (
            WHERE s.labeled_weight IS NOT NULL AND s.labeled_weight > 0
              AND abs(s.weight_variance / s.labeled_weight) > public.inbound_weight_tolerance()
        )::INTEGER,
        COALESCE(SUM(ROUND(s.weight_variance * s.purchase_unit_price, 0)), 0)
    FROM public.inbound_scans s
    WHERE s.wholesaler_id = public.resolve_current_wholesaler_id()
      AND (SELECT public.can_view_cost(public.resolve_current_wholesaler_id()))
      AND public.feature_effective(public.resolve_current_wholesaler_id(), 'accounting_purchases')
      AND s.status <> 'VOIDED'
      -- 쪼개서 생긴 부위 박스의 단가는 지육 원가를 나눈 것이다(231). 실제 지출은 부모 박스 한 곳에서만 센다.
      AND s.parent_scan_id IS NULL
      AND (p_from IS NULL OR s.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR s.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR s.product_id = p_product_id)
      AND (
            NULLIF(btrim(COALESCE(p_supplier, '')), '') IS NULL
         OR s.purchase_supplier ILIKE '%' || btrim(p_supplier) || '%'
      );
$function$;
