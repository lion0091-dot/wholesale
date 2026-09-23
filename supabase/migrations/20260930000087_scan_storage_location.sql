-- 입고 박스에 보관 위치(선택) 기록 — 플랫폼 위 여러 도매업체가 저마다 다른
-- 창고 구조를 쓰므로, 위치 이름을 고정하지 않고 각 업체가 자유 텍스트로
-- 만들어 쓰게 한다(2026-09-24, 사장님 확정: "창고 구조를 하나로 고정하면
-- 안 된다"). 텍스트 + 참고용 사진(사람이 보고 알아보는 용도, AI 인식 아님)
-- 둘 다 완전히 선택사항 — 입고 스캔 자체를 막지 않고, 나중에 언제든 채울 수 있다.
--
-- 선입선출로 "이 박스를 먼저 내보내라"까지는 이미 알려주는데(get_picking_list,
-- 20260930000067), 그 박스가 창고 어디 있는지는 사람이 찾아야 했다. 이 위치를
-- 피킹 목록에 같이 보여줘서 그 문제를 줄인다.

ALTER TABLE public.inbound_scans
    ADD COLUMN IF NOT EXISTS storage_location TEXT,
    ADD COLUMN IF NOT EXISTS storage_location_photo_path TEXT;

COMMENT ON COLUMN public.inbound_scans.storage_location IS
    '보관 위치(선택, 자유 텍스트). 업체마다 창고 구조가 달라 고정 목록을 두지 않는다 — 한 번 입력하면 다음부터 같은 업체 화면에서 골라 쓸 수 있다.';
COMMENT ON COLUMN public.inbound_scans.storage_location_photo_path IS
    '보관 위치 참고 사진 경로(선택). AI 인식용이 아니라 사람이 보고 그 자리를 알아보게 하는 용도.';


-- --------------------------------------------------------------------
-- 위치 지정 RPC — inbound_scans는 RLS가 SELECT만 허용하므로(설계 결정 6번)
-- 앱에서 직접 UPDATE할 수 없다. GTIN 기록(set_scan_gtin, 20260930000076)과
-- 같은 이유로 작은 전용 RPC를 둔다. 재고 수량에 영향이 없는 참고 값이다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_scan_storage_location(
    p_scan_id UUID,
    p_location TEXT,
    p_photo_path TEXT DEFAULT NULL,
    -- true면 사진 칸을 안 건드린다(위치 이름만 고칠 때 기존 사진을 안 지우려고).
    -- false면 p_photo_path로 덮어쓴다(새 사진 업로드 성공, 또는 명시적으로 지우는 NULL).
    p_keep_existing_photo BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    UPDATE public.inbound_scans
    SET storage_location = NULLIF(btrim(COALESCE(p_location, '')), ''),
        storage_location_photo_path = CASE
            WHEN p_keep_existing_photo THEN storage_location_photo_path
            ELSE p_photo_path
        END,
        updated_at = now()
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id;

    RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_scan_storage_location(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_scan_storage_location(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;


-- --------------------------------------------------------------------
-- 피킹 목록에 위치 노출 — 반환 컬럼이 늘어 REPLACE가 안 되니 DROP 후 재생성
-- (best_before, 20260930000070과 같은 이유).
-- --------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_picking_list(UUID);

CREATE OR REPLACE FUNCTION public.get_picking_list(p_order_id UUID)
RETURNS TABLE (
    product_id     UUID,
    product_name   TEXT,
    unit           TEXT,
    box_id         UUID,
    trace_no       TEXT,
    suggested_qty  NUMERIC,
    box_weight     NUMERIC,
    grade          TEXT,
    slaughter_date DATE,
    scanned_at     TIMESTAMPTZ,
    already_picked BOOLEAN,
    storage_location TEXT,
    storage_location_photo_path TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH authorized AS (
        SELECT o.id, o.wholesaler_id
        FROM public.orders o
        WHERE o.id = p_order_id
          AND (
                public.can_access_wholesaler(o.wholesaler_id)
          )
    ),
    scan_started AS (
        SELECT EXISTS (
            SELECT 1 FROM public.stock_ledger
            WHERE source_type = 'order' AND source_id = p_order_id
              AND event_type = 'OUTBOUND_ASSIGN'
        ) AS started
    ),
    -- (A) 스캔 전 — 확정 때 잡아둔 선입선출 배정이 곧 추천이다.
    from_auto AS (
        SELECT
            l.product_id,
            p.name AS product_name,
            p.unit,
            s.id AS box_id,
            s.trace_no,
            -l.qty_delta AS suggested_qty,
            s.weight AS box_weight,
            m.grade,
            m.slaughter_date,
            s.created_at AS scanned_at,
            false AS already_picked,
            s.storage_location,
            s.storage_location_photo_path
        FROM public.stock_ledger l
        JOIN authorized a ON a.id = l.source_id
        JOIN public.inbound_scans s ON s.id = l.inbound_scan_id
        JOIN public.products p ON p.id = l.product_id
        LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
        WHERE l.source_type = 'order' AND l.source_id = p_order_id
          AND l.event_type = 'ORDER_OUT'
          AND l.inbound_scan_id IS NOT NULL
          AND NOT (SELECT started FROM scan_started)
    ),
    -- (B) 스캔 후 — 남은 필요량을 현재 가용 박스에서 선입선출로 계산한다.
    needs AS (
        SELECT
            i.product_id,
            SUM(i.quantity) AS ordered,
            COALESCE((
                SELECT SUM(-l.qty_delta)
                FROM public.stock_ledger l
                WHERE l.source_type = 'order' AND l.source_id = p_order_id
                  AND l.event_type = 'OUTBOUND_ASSIGN'
                  AND l.product_id = i.product_id
            ), 0) AS assigned
        FROM public.order_items i
        JOIN authorized a ON a.id = i.order_id
        WHERE (SELECT started FROM scan_started)
        GROUP BY i.product_id
    ),
    running AS (
        SELECT
            s.id AS box_id,
            s.product_id,
            s.trace_no,
            s.weight,
            s.remaining_weight,
            s.created_at,
            s.storage_location,
            s.storage_location_photo_path,
            n.ordered - n.assigned AS needed,
            -- 이 박스 앞까지의 누적 — 필요량을 채우고 남는 박스는 목록에서 뺀다.
            SUM(s.remaining_weight) OVER (
                PARTITION BY s.product_id ORDER BY s.created_at, s.id
                ROWS UNBOUNDED PRECEDING
            ) - s.remaining_weight AS before_this
        FROM public.inbound_scans s
        JOIN needs n ON n.product_id = s.product_id
        JOIN authorized a ON a.wholesaler_id = s.wholesaler_id
        WHERE s.status = 'NORMAL'
          AND s.remaining_weight > 0
          AND n.ordered - n.assigned > 0
    ),
    from_remaining AS (
        SELECT
            r.product_id,
            p.name,
            p.unit,
            r.box_id,
            r.trace_no,
            LEAST(r.remaining_weight, r.needed - r.before_this) AS suggested_qty,
            r.weight,
            m.grade,
            m.slaughter_date,
            r.created_at,
            false,
            r.storage_location,
            r.storage_location_photo_path
        FROM running r
        JOIN public.products p ON p.id = r.product_id
        LEFT JOIN public.master_livestock m ON m.trace_no = r.trace_no
        WHERE r.before_this < r.needed
    ),
    -- (C) 이미 찍은 박스 — 목록에 남겨 표시한다 (설계 결정 2번).
    already AS (
        SELECT
            l.product_id,
            p.name,
            p.unit,
            s.id,
            s.trace_no,
            -l.qty_delta,
            s.weight,
            m.grade,
            m.slaughter_date,
            s.created_at,
            true,
            s.storage_location,
            s.storage_location_photo_path
        FROM public.stock_ledger l
        JOIN authorized a ON a.id = l.source_id
        JOIN public.inbound_scans s ON s.id = l.inbound_scan_id
        JOIN public.products p ON p.id = l.product_id
        LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
        WHERE l.source_type = 'order' AND l.source_id = p_order_id
          AND l.event_type = 'OUTBOUND_ASSIGN'
    )
    SELECT * FROM from_auto
    UNION ALL
    SELECT * FROM from_remaining
    UNION ALL
    SELECT * FROM already
    -- 이미 찍은 건 아래로, 나머지는 오래된 순(선입선출).
    ORDER BY 11, 10;
$$;

REVOKE EXECUTE ON FUNCTION public.get_picking_list(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_picking_list(UUID) TO authenticated;


-- --------------------------------------------------------------------
-- 위치 참고 사진 보관용 Storage 버킷 (inbound-documents와 같은 패턴 —
-- 업체 폴더 단위 권한, private).
-- --------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('scan-location-photos', 'scan-location-photos', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Scan location photos insert by wholesaler members" ON storage.objects;
DROP POLICY IF EXISTS "Scan location photos select by wholesaler members" ON storage.objects;
DROP POLICY IF EXISTS "Scan location photos update by wholesaler members" ON storage.objects;
DROP POLICY IF EXISTS "Scan location photos delete by wholesaler members" ON storage.objects;

CREATE POLICY "Scan location photos insert by wholesaler members"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'scan-location-photos'
    AND public.can_access_wholesaler_folder((storage.foldername(name))[1])
);

CREATE POLICY "Scan location photos select by wholesaler members"
ON storage.objects FOR SELECT TO authenticated
USING (
    bucket_id = 'scan-location-photos'
    AND (
        public.can_access_wholesaler_folder((storage.foldername(name))[1])
        OR public.get_current_role() = 'super_admin'
    )
);

CREATE POLICY "Scan location photos update by wholesaler members"
ON storage.objects FOR UPDATE TO authenticated
USING (
    bucket_id = 'scan-location-photos'
    AND public.can_access_wholesaler_folder((storage.foldername(name))[1])
) WITH CHECK (
    bucket_id = 'scan-location-photos'
    AND public.can_access_wholesaler_folder((storage.foldername(name))[1])
);

CREATE POLICY "Scan location photos delete by wholesaler members"
ON storage.objects FOR DELETE TO authenticated
USING (
    bucket_id = 'scan-location-photos'
    AND public.can_access_wholesaler_folder((storage.foldername(name))[1])
);
