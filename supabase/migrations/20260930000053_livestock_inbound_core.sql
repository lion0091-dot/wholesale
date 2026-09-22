-- ====================================================================
-- 축산물 이력 입고 시스템 — 코어 스키마 (1단계)
--
-- 바코드/카메라로 이력번호를 찍으면 축산물이력제 공공 API와 대조해 검증하고,
-- 박스 단위로 재고를 쌓는다. 기존 products/orders는 건드리지 않는다
-- (products.stock_quantity는 컬럼 그대로 두고 "누가 쓰느냐"만 원장으로 바뀐다).
--
-- 잠긴 설계 결정 (docs/livestock-inbound-tracking.md 참고):
--
--  1. 재고의 실제 단위는 이력번호가 아니라 "박스 한 개"(inbound_scans.id)다.
--     같은 이력번호로 박스가 여러 개 들어온다 — 소 한 마리(개체번호 12자리)에서
--     등심 박스가 여럿 나오고, 묶음번호(15자리)는 애초에 여러 마리를 묶은 번호다.
--     그래서 trace_no로는 중복 스캔을 막을 수 없고, UNIQUE도 걸 수 없다.
--
--  2. 수량은 stock_ledger(원장)에만 기록하고 products.stock_quantity는 그 합계로
--     파생시킨다. 취소는 행 삭제가 아니라 반대 부호 행 추가(역분개)다.
--     products.stock_quantity >= 0 CHECK가 "이미 팔려나간 입고를 취소"하는
--     불가능한 상태를 막는 가드로 동작한다.
--
--  3. master_livestock은 전 업체 공용 캐시다. 공공 API가 전체 덤프를 주지 않아
--     (이력번호를 알아야 조회 가능) 미리 채울 방법이 없다 — 스캔되는 순간
--     한 건씩 채워지는 Lazy Loading 캐시다.
--
--  4. 실제 API 응답 필드를 아직 확정할 수 없어(인증키 미발급) raw_payload jsonb에
--     원본을 통째로 보관한다. 특히 "부위(part_name)"는 이력번호가 개체 단위라
--     응답에 없을 수 있다 — 없으면 사용자에게 한 번 물어보고 trace_product_map에
--     학습시킨다.
--
--  5. 모든 쓰기는 SECURITY DEFINER RPC를 통한다. 테이블에는 SELECT 정책만 두어
--     원장을 우회해 재고를 직접 고치는 경로를 원천 차단한다.
-- ====================================================================


-- --------------------------------------------------------------------
-- 0. 헬퍼 — owner 계정과 초대받은 직원 계정 모두에서 wholesaler_id를 얻는다.
--    get_current_wholesaler_id()는 owner(wholesalers.profile_id)만 인식해서
--    직원 계정이면 NULL이 된다 (20260930000024_org_staff_rls_gap.sql 참고).
--    NOTE: 한 계정이 여러 조직에 속하는 경우는 현재 UI상 없어 limit 1로 둔다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_current_wholesaler_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(
        public.get_current_wholesaler_id(),
        (
            SELECT o.wholesaler_id
            FROM public.organization_staff s
            JOIN public.organizations o ON o.id = s.organization_id
            WHERE s.user_id = auth.uid()
            LIMIT 1
        )
    );
$$;


-- --------------------------------------------------------------------
-- 1. MASTER_LIVESTOCK — 공공 API 응답 캐시 (플랫폼 공용, 업체 구분 없음)
-- --------------------------------------------------------------------
CREATE TABLE public.master_livestock (
    trace_no         TEXT PRIMARY KEY,
    -- individual: 개체식별번호(소 12자리) / group: 묶음번호(15자리) / imported: 수입유통식별번호
    trace_kind       TEXT NOT NULL CHECK (trace_kind IN ('individual', 'group', 'imported')),
    -- API가 주는 원문 축종 (한우/육우/젖소/돼지 등)
    species          TEXT,
    -- products.category와 맞추기 위한 정규화값 (소/돼지/닭·오리/양/가공육)
    species_group    TEXT,
    -- 부위. API 응답에 없을 수 있다 (설계 결정 4번) — NULL이면 사용자에게 되묻는다.
    part_name        TEXT,
    grade            TEXT,
    slaughter_date   DATE,
    butchery_place   TEXT,
    farm_name        TEXT,
    origin_country   TEXT,
    importer_name    TEXT,
    -- 'mtrace_livestock'(소·돼지) | 'mtrace_imported'(수입쇠고기)
    source           TEXT NOT NULL,
    -- 파싱 실패/스펙 변경에 대비한 원본 응답 전문
    raw_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_master_livestock_lookup
    ON public.master_livestock (species_group, part_name, grade);

ALTER TABLE public.master_livestock ENABLE ROW LEVEL SECURITY;

-- 공공 데이터라 로그인 사용자는 모두 읽을 수 있다. 쓰기 정책은 두지 않는다 —
-- 적재는 아래 upsert_master_livestock() (SECURITY DEFINER)로만 가능하다.
CREATE POLICY "Master livestock viewable by authenticated" ON public.master_livestock
    FOR SELECT TO authenticated USING (true);

DROP TRIGGER IF EXISTS trg_master_livestock_updated_at ON public.master_livestock;
CREATE TRIGGER trg_master_livestock_updated_at
    BEFORE UPDATE ON public.master_livestock
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- --------------------------------------------------------------------
-- 2. TRACE_PRODUCT_MAP — "축종+부위+등급 → 우리 상품" 매핑 학습 (업체별)
--    한 번 답하면 다음부터 안 묻는다.
-- --------------------------------------------------------------------
CREATE TABLE public.trace_product_map (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    species_group TEXT NOT NULL,
    part_name     TEXT NOT NULL,
    -- NULL이면 "등급 무관" — 등급별로 다른 상품을 쓰는 업체만 채운다.
    grade         TEXT,
    product_id    UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    created_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- grade NULL을 같은 값으로 취급해야 해서 표현식 인덱스로 건다.
CREATE UNIQUE INDEX idx_trace_product_map_unique
    ON public.trace_product_map (wholesaler_id, species_group, part_name, COALESCE(grade, ''));

ALTER TABLE public.trace_product_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Trace product map viewable by owner, org staff, or admin" ON public.trace_product_map
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR public.get_current_role() = 'super_admin'
    );

DROP TRIGGER IF EXISTS trg_trace_product_map_updated_at ON public.trace_product_map;
CREATE TRIGGER trg_trace_product_map_updated_at
    BEFORE UPDATE ON public.trace_product_map
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- --------------------------------------------------------------------
-- 3. INBOUND_SCANS — 박스 한 개 = 한 행. 재고의 실제 단위 (설계 결정 1번)
-- --------------------------------------------------------------------
CREATE TABLE public.inbound_scans (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id    UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    trace_no         TEXT NOT NULL,
    -- 매핑 전에는 NULL. resolve_inbound_mapping()으로 채워진다.
    product_id       UUID REFERENCES public.products(id) ON DELETE RESTRICT,
    weight           NUMERIC(10, 2) NOT NULL CHECK (weight > 0),
    unit             TEXT NOT NULL DEFAULT 'kg',
    scan_type        TEXT NOT NULL CHECK (scan_type IN ('BARCODE_SCAN', 'CAMERA', 'EXCEL', 'MANUAL')),
    -- PENDING_MAPPING: 이력은 찾았으나 어느 상품인지 미확정 (사용자에게 되물어야 함)
    -- EXCEPTION:       이력 자체를 못 찾음 (API 실패/미존재)
    -- NORMAL:          재고에 반영됨
    -- VOIDED:          오스캔 취소됨 (역분개 완료)
    status           TEXT NOT NULL CHECK (status IN ('PENDING_MAPPING', 'EXCEPTION', 'NORMAL', 'VOIDED')),
    -- 이 박스에 남은 중량. 출고할 때 선입선출로 여기서 깎는다.
    remaining_weight NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (remaining_weight >= 0),
    import_row_id    UUID,
    memo             TEXT,
    scanned_by       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inbound_scans_recent
    ON public.inbound_scans (wholesaler_id, created_at DESC);

-- 출고 시 선입선출로 뺄 박스를 고르는 전용 인덱스.
CREATE INDEX idx_inbound_scans_available
    ON public.inbound_scans (wholesaler_id, product_id, created_at)
    WHERE status = 'NORMAL' AND remaining_weight > 0;

CREATE INDEX idx_inbound_scans_trace ON public.inbound_scans (trace_no);

ALTER TABLE public.inbound_scans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Inbound scans viewable by owner, org staff, or admin" ON public.inbound_scans
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR public.get_current_role() = 'super_admin'
    );

DROP TRIGGER IF EXISTS trg_inbound_scans_updated_at ON public.inbound_scans;
CREATE TRIGGER trg_inbound_scans_updated_at
    BEFORE UPDATE ON public.inbound_scans
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- --------------------------------------------------------------------
-- 4. STOCK_LEDGER — 입출고 원장. 재고의 유일한 진실 (설계 결정 2번)
-- --------------------------------------------------------------------
CREATE TABLE public.stock_ledger (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id   UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
    -- 어느 박스에서 들어오고 나갔는지. 이게 있어야 거래명세서에 이력번호를 찍을 수 있다.
    inbound_scan_id UUID REFERENCES public.inbound_scans(id) ON DELETE RESTRICT,
    qty_delta       NUMERIC(10, 2) NOT NULL CHECK (qty_delta <> 0),
    -- OPENING_BALANCE: 원장 도입 전 수동으로 입력돼 있던 재고를 기초재고로 이관한 행.
    --   이게 없으면 첫 입고 스캔 순간 재고가 원장 합계(=그 박스 한 개)로 덮어써져
    --   기존 수동 재고가 통째로 증발한다.
    -- ORDER_OUT:  주문 출고 차감. '확정(confirmed)' 진입 시점에 잡는다 — 확정과 실제
    --   출고 사이에 다른 거래처가 같은 박스를 주문해 이중 판매되는 걸 막기 위해서다.
    -- ORDER_RESTORE: 주문 취소 시 원복(역분개).
    event_type      TEXT NOT NULL CHECK (event_type IN (
                        'INBOUND', 'INBOUND_VOID',
                        'OPENING_BALANCE',
                        'ORDER_OUT', 'ORDER_RESTORE',
                        'ADJUSTMENT', 'LOSS'
                    )),
    source_type     TEXT NOT NULL CHECK (source_type IN ('inbound_scan', 'order', 'product', 'manual')),
    source_id       UUID,
    reason          TEXT,
    created_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 멱등성 — 같은 이벤트가 재시도로 두 번 기록되는 걸 DB가 막는다.
-- (예: 입고 1건당 INBOUND 1행, 주문 1건의 한 박스 출고당 ORDER_OUT 1행,
--  상품 1개당 OPENING_BALANCE 1행)
CREATE UNIQUE INDEX idx_stock_ledger_idempotent
    ON public.stock_ledger (event_type, source_type, source_id, COALESCE(inbound_scan_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE source_id IS NOT NULL;

CREATE INDEX idx_stock_ledger_product ON public.stock_ledger (product_id);
CREATE INDEX idx_stock_ledger_recent ON public.stock_ledger (wholesaler_id, created_at DESC);

ALTER TABLE public.stock_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Stock ledger viewable by owner, org staff, or admin" ON public.stock_ledger
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR public.get_current_role() = 'super_admin'
    );


-- --------------------------------------------------------------------
-- 5. LIVESTOCK_EXCEPTION_LOG — 검증 실패 건. 관리자가 수동 보정한다.
-- --------------------------------------------------------------------
CREATE TABLE public.livestock_exception_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id   UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    inbound_scan_id UUID REFERENCES public.inbound_scans(id) ON DELETE CASCADE,
    raw_input       TEXT NOT NULL,
    reason          TEXT NOT NULL CHECK (reason IN (
                        'NOT_FOUND',        -- API에 해당 이력번호가 없음
                        'API_ERROR',        -- 호출 실패/타임아웃
                        'INVALID_FORMAT',   -- 자릿수 등 형식 오류
                        'UNMAPPED_PRODUCT'  -- 이력은 찾았으나 상품 매핑 미확정
                    )),
    detail          TEXT,
    resolved_status TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (resolved_status IN ('PENDING', 'RESOLVED', 'DISCARDED')),
    resolved_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_livestock_exception_pending
    ON public.livestock_exception_log (wholesaler_id, resolved_status, created_at DESC);

ALTER TABLE public.livestock_exception_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Exception log viewable by owner, org staff, or admin" ON public.livestock_exception_log
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR public.get_current_role() = 'super_admin'
    );


-- --------------------------------------------------------------------
-- 6. 엑셀 대량 업로드 큐
--    Vercel Hobby는 크론이 2개(이미 소진)뿐이고 하루 1회라 배치로 소화할 수 없다.
--    브라우저가 processChunk를 반복 호출해 20건씩 소화하는 구조 — 그래서
--    작업 상태를 DB에 들고 있어야 창을 닫았다 다시 열어도 이어서 처리된다.
-- --------------------------------------------------------------------
CREATE TABLE public.inbound_import_jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    file_name     TEXT NOT NULL,
    storage_path  TEXT,
    total_rows    INTEGER NOT NULL DEFAULT 0,
    done_rows     INTEGER NOT NULL DEFAULT 0,
    failed_rows   INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'CANCELLED')),
    created_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.inbound_import_rows (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id       UUID NOT NULL REFERENCES public.inbound_import_jobs(id) ON DELETE CASCADE,
    row_no       INTEGER NOT NULL,
    trace_no     TEXT NOT NULL,
    weight       NUMERIC(10, 2),
    status       TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'DONE', 'FAILED')),
    scan_id      UUID REFERENCES public.inbound_scans(id) ON DELETE SET NULL,
    error_detail TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, row_no)
);

CREATE INDEX idx_inbound_import_rows_pending
    ON public.inbound_import_rows (job_id, row_no)
    WHERE status = 'PENDING';

ALTER TABLE public.inbound_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_import_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Import jobs viewable by owner, org staff, or admin" ON public.inbound_import_jobs
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR public.get_current_role() = 'super_admin'
    );

CREATE POLICY "Import rows viewable via parent job" ON public.inbound_import_rows
    FOR SELECT USING (
        job_id IN (SELECT id FROM public.inbound_import_jobs)
    );

DROP TRIGGER IF EXISTS trg_inbound_import_jobs_updated_at ON public.inbound_import_jobs;
CREATE TRIGGER trg_inbound_import_jobs_updated_at
    BEFORE UPDATE ON public.inbound_import_jobs
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ====================================================================
-- RPC — 모든 쓰기는 여기를 통한다.
--
-- Supabase JS 클라이언트는 다중 문장 트랜잭션을 지원하지 않는다. 입고 1건은
-- "스캔 기록 + 원장 + 재고 갱신 + (실패 시) 예외 이관"이 전부 성공하거나 전부
-- 실패해야 하므로 SQL 함수 하나로 묶는다.
-- ====================================================================


-- --------------------------------------------------------------------
-- 내부 헬퍼 — products.stock_quantity를 원장 합계로 다시 계산한다.
-- products의 CHECK (stock_quantity >= 0)가 "이미 팔려나간 입고를 취소"처럼
-- 불가능한 상태를 만들려는 트랜잭션을 통째로 되돌리는 가드로 동작한다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalc_product_stock(p_product_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.products
    SET stock_quantity = (
            SELECT COALESCE(SUM(qty_delta), 0)
            FROM public.stock_ledger
            WHERE product_id = p_product_id
        ),
        updated_at = now()
    WHERE id = p_product_id;
$$;

-- 내부 전용 — 앱에서 직접 부르면 원장을 우회해 재고를 흔들 수 있다.
REVOKE EXECUTE ON FUNCTION public.recalc_product_stock(UUID) FROM PUBLIC;


-- --------------------------------------------------------------------
-- 기초재고 이관 — 어떤 상품이 원장에 처음 편입될 때 딱 한 번 실행된다.
--
-- 원장 도입 전에는 stock_quantity를 사람이 손으로 넣었다. 그 상태에서 첫
-- 입고 스캔이 들어오면 recalc_product_stock()이 재고를 원장 합계(=방금 찍은
-- 박스 한 개)로 덮어써서 기존 수동 재고가 통째로 증발한다.
-- 그래서 첫 원장 행을 쓰기 전에 현재 stock_quantity를 OPENING_BALANCE 행으로
-- 옮겨 담는다. 멱등 인덱스가 상품당 1행만 허용한다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_opening_balance(p_product_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_product public.products%ROWTYPE;
BEGIN
    IF EXISTS (SELECT 1 FROM public.stock_ledger WHERE product_id = p_product_id) THEN
        RETURN;
    END IF;

    SELECT * INTO v_product FROM public.products WHERE id = p_product_id;

    IF v_product.id IS NULL OR COALESCE(v_product.stock_quantity, 0) <= 0 THEN
        RETURN;
    END IF;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, reason, created_by
    ) VALUES (
        v_product.wholesaler_id, p_product_id, NULL, v_product.stock_quantity,
        'OPENING_BALANCE', 'product', p_product_id,
        '원장 도입 전 수동 입력 재고 이관', auth.uid()
    )
    ON CONFLICT DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ensure_opening_balance(UUID) FROM PUBLIC;


-- --------------------------------------------------------------------
-- 공공 API 응답을 마스터 캐시에 적재한다 (Lazy Loading의 적재 단계).
-- 실제 호출은 Server Action이 하고(SQL에서 외부 HTTP 호출 불가) 결과만 넘긴다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_master_livestock(
    p_trace_no       TEXT,
    p_trace_kind     TEXT,
    p_source         TEXT,
    p_raw_payload    JSONB,
    p_species        TEXT DEFAULT NULL,
    p_species_group  TEXT DEFAULT NULL,
    p_part_name      TEXT DEFAULT NULL,
    p_grade          TEXT DEFAULT NULL,
    p_slaughter_date DATE DEFAULT NULL,
    p_butchery_place TEXT DEFAULT NULL,
    p_farm_name      TEXT DEFAULT NULL,
    p_origin_country TEXT DEFAULT NULL,
    p_importer_name  TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 공용 캐시라 아무나 쓰게 두면 오염된다. 공급사 계정만 적재할 수 있다.
    IF public.resolve_current_wholesaler_id() IS NULL
       AND public.get_current_role() <> 'super_admin' THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    INSERT INTO public.master_livestock AS m (
        trace_no, trace_kind, source, raw_payload, species, species_group,
        part_name, grade, slaughter_date, butchery_place, farm_name,
        origin_country, importer_name, fetched_at
    ) VALUES (
        upper(trim(p_trace_no)), p_trace_kind, p_source, COALESCE(p_raw_payload, '{}'::jsonb),
        p_species, p_species_group, p_part_name, p_grade, p_slaughter_date,
        p_butchery_place, p_farm_name, p_origin_country, p_importer_name, now()
    )
    ON CONFLICT (trace_no) DO UPDATE SET
        trace_kind     = EXCLUDED.trace_kind,
        source         = EXCLUDED.source,
        raw_payload    = EXCLUDED.raw_payload,
        -- 재조회 결과가 비어 있으면 기존 값을 지우지 않는다 (부분 응답 대비).
        species        = COALESCE(EXCLUDED.species, m.species),
        species_group  = COALESCE(EXCLUDED.species_group, m.species_group),
        part_name      = COALESCE(EXCLUDED.part_name, m.part_name),
        grade          = COALESCE(EXCLUDED.grade, m.grade),
        slaughter_date = COALESCE(EXCLUDED.slaughter_date, m.slaughter_date),
        butchery_place = COALESCE(EXCLUDED.butchery_place, m.butchery_place),
        farm_name      = COALESCE(EXCLUDED.farm_name, m.farm_name),
        origin_country = COALESCE(EXCLUDED.origin_country, m.origin_country),
        importer_name  = COALESCE(EXCLUDED.importer_name, m.importer_name),
        fetched_at     = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_master_livestock(
    TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT
) TO authenticated;


-- --------------------------------------------------------------------
-- 입고 스캔 1건 기록. 스캔 + 원장 + 재고 + 예외를 한 트랜잭션으로 처리한다.
--
-- 호출 전 Server Action이 할 일:
--   1) master_livestock 조회 (캐시 히트면 바로 여기로)
--   2) 미스면 공공 API 호출 → upsert_master_livestock()으로 적재
--   3) 그 다음 이 함수 호출
-- API가 실패했으면 p_fail_reason에 'API_ERROR'를 넘긴다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_inbound_scan(
    p_trace_no      TEXT,
    p_weight        NUMERIC,
    p_scan_type     TEXT,
    p_product_id    UUID DEFAULT NULL,
    p_fail_reason   TEXT DEFAULT NULL,
    p_import_row_id UUID DEFAULT NULL,
    p_memo          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_trace_no      TEXT;
    v_master        public.master_livestock%ROWTYPE;
    v_product_id    UUID;
    v_status        TEXT;
    v_scan_id       UUID;
    v_reason        TEXT;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    IF p_weight IS NULL OR p_weight <= 0 THEN
        RAISE EXCEPTION 'INVALID_WEIGHT';
    END IF;

    v_trace_no := upper(trim(COALESCE(p_trace_no, '')));
    IF v_trace_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_trace_no;

    -- 상품 결정: 사용자가 직접 고른 값 > 학습된 매핑 > 미확정
    IF p_product_id IS NOT NULL THEN
        SELECT id INTO v_product_id
        FROM public.products
        WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;

        IF v_product_id IS NULL THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
        END IF;

    ELSIF v_master.trace_no IS NOT NULL AND v_master.part_name IS NOT NULL THEN
        -- 등급까지 일치하는 매핑을 우선하고, 없으면 등급 무관(NULL) 매핑을 쓴다.
        SELECT product_id INTO v_product_id
        FROM public.trace_product_map
        WHERE wholesaler_id = v_wholesaler_id
          AND species_group = v_master.species_group
          AND part_name = v_master.part_name
          AND (grade IS NULL OR grade = v_master.grade)
        ORDER BY grade NULLS LAST
        LIMIT 1;
    END IF;

    IF v_master.trace_no IS NULL THEN
        v_status := 'EXCEPTION';
        v_reason := COALESCE(p_fail_reason, 'NOT_FOUND');
    ELSIF v_product_id IS NULL THEN
        -- 이력은 확인됐다. 어느 상품인지만 사용자에게 한 번 물어보면 된다.
        v_status := 'PENDING_MAPPING';
        v_reason := 'UNMAPPED_PRODUCT';
    ELSE
        v_status := 'NORMAL';
        v_reason := NULL;
    END IF;

    INSERT INTO public.inbound_scans (
        wholesaler_id, trace_no, product_id, weight, scan_type, status,
        remaining_weight, import_row_id, memo, scanned_by
    ) VALUES (
        v_wholesaler_id, v_trace_no, v_product_id, p_weight, p_scan_type, v_status,
        CASE WHEN v_status = 'NORMAL' THEN p_weight ELSE 0 END,
        p_import_row_id, p_memo, auth.uid()
    )
    RETURNING id INTO v_scan_id;

    IF v_status = 'NORMAL' THEN
        -- 이 상품의 첫 원장 행이면 기존 수동 재고를 기초재고로 먼저 옮긴다.
        PERFORM public.ensure_opening_balance(v_product_id);

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, created_by
        ) VALUES (
            v_wholesaler_id, v_product_id, v_scan_id, p_weight,
            'INBOUND', 'inbound_scan', v_scan_id, auth.uid()
        );

        PERFORM public.recalc_product_stock(v_product_id);
    ELSE
        INSERT INTO public.livestock_exception_log (
            wholesaler_id, inbound_scan_id, raw_input, reason, detail
        ) VALUES (
            v_wholesaler_id, v_scan_id, v_trace_no, v_reason,
            CASE WHEN v_status = 'PENDING_MAPPING'
                 THEN '이력 조회는 성공했으나 상품 매핑이 확정되지 않았습니다.'
                 ELSE NULL END
        );
    END IF;

    RETURN jsonb_build_object(
        'scan_id',      v_scan_id,
        'trace_no',     v_trace_no,
        'status',       v_status,
        'product_id',   v_product_id,
        'master_found', v_master.trace_no IS NOT NULL,
        'species_group', v_master.species_group,
        'part_name',    v_master.part_name,
        'grade',        v_master.grade,
        'slaughter_date', v_master.slaughter_date
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_inbound_scan(TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT) TO authenticated;


-- --------------------------------------------------------------------
-- 미확정/예외 스캔에 상품을 지정해 재고로 확정한다.
-- p_remember = true면 같은 축종+부위+등급을 다음부터 자동 매핑한다 (학습).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_inbound_mapping(
    p_scan_id    UUID,
    p_product_id UUID,
    p_remember   BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_master        public.master_livestock%ROWTYPE;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id
    FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status NOT IN ('PENDING_MAPPING', 'EXCEPTION') THEN
        RAISE EXCEPTION 'SCAN_ALREADY_RESOLVED';
    END IF;

    PERFORM 1 FROM public.products
    WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    UPDATE public.inbound_scans
    SET product_id = p_product_id,
        status = 'NORMAL',
        remaining_weight = weight
    WHERE id = p_scan_id;

    PERFORM public.ensure_opening_balance(p_product_id);

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, created_by
    ) VALUES (
        v_wholesaler_id, p_product_id, p_scan_id, v_scan.weight,
        'INBOUND', 'inbound_scan', p_scan_id, auth.uid()
    );

    PERFORM public.recalc_product_stock(p_product_id);

    UPDATE public.livestock_exception_log
    SET resolved_status = 'RESOLVED',
        resolved_by = auth.uid(),
        resolved_at = now()
    WHERE inbound_scan_id = p_scan_id AND resolved_status = 'PENDING';

    -- 학습: 부위를 아는 경우에만 저장한다 (부위 없이 저장하면 전혀 다른 고기가 매핑된다).
    IF p_remember THEN
        SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_scan.trace_no;

        IF v_master.part_name IS NOT NULL AND v_master.species_group IS NOT NULL THEN
            INSERT INTO public.trace_product_map (
                wholesaler_id, species_group, part_name, grade, product_id, created_by
            ) VALUES (
                v_wholesaler_id, v_master.species_group, v_master.part_name,
                v_master.grade, p_product_id, auth.uid()
            )
            ON CONFLICT (wholesaler_id, species_group, part_name, COALESCE(grade, ''))
            DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now();
        END IF;
    END IF;

    RETURN jsonb_build_object('scan_id', p_scan_id, 'status', 'NORMAL', 'product_id', p_product_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_inbound_mapping(UUID, UUID, BOOLEAN) TO authenticated;


-- --------------------------------------------------------------------
-- 오스캔 취소. 행을 지우지 않고 반대 부호 원장 행을 추가한다(역분개).
-- 이미 일부라도 출고된 박스는 취소할 수 없다 — 재고 이력이 깨진다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_inbound_scan(
    p_scan_id UUID,
    p_reason  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id
    FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status = 'VOIDED' THEN
        RAISE EXCEPTION 'ALREADY_VOIDED';
    END IF;

    IF v_scan.status = 'NORMAL' THEN
        IF v_scan.remaining_weight <> v_scan.weight THEN
            RAISE EXCEPTION 'PARTIALLY_SHIPPED';
        END IF;

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) VALUES (
            v_wholesaler_id, v_scan.product_id, p_scan_id, -v_scan.weight,
            'INBOUND_VOID', 'inbound_scan', p_scan_id, p_reason, auth.uid()
        );
    END IF;

    UPDATE public.inbound_scans
    SET status = 'VOIDED',
        remaining_weight = 0,
        memo = COALESCE(p_reason, memo)
    WHERE id = p_scan_id;

    IF v_scan.product_id IS NOT NULL THEN
        PERFORM public.recalc_product_stock(v_scan.product_id);
    END IF;

    UPDATE public.livestock_exception_log
    SET resolved_status = 'DISCARDED',
        resolved_by = auth.uid(),
        resolved_at = now()
    WHERE inbound_scan_id = p_scan_id AND resolved_status = 'PENDING';

    RETURN jsonb_build_object('scan_id', p_scan_id, 'status', 'VOIDED');
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_inbound_scan(UUID, TEXT) TO authenticated;


-- ====================================================================
-- 테이블 권한
--
-- RLS 정책과 별개로 테이블 GRANT가 없으면 authenticated 롤은 아무것도 못 읽는다
-- (20260924000000_fix_wholesaler_retailers_rls.sql 주석 참고 — 이 저장소가 이미
-- 한 번 겪은 함정이다).
--
-- 재고에 영향을 주는 테이블은 SELECT만 준다. 쓰기는 위 RPC로만 가능해서
-- 원장을 우회해 재고를 직접 고치는 경로가 존재하지 않는다.
-- ====================================================================
GRANT SELECT ON public.master_livestock        TO authenticated;
GRANT SELECT ON public.trace_product_map       TO authenticated;
GRANT SELECT ON public.inbound_scans           TO authenticated;
GRANT SELECT ON public.stock_ledger            TO authenticated;
GRANT SELECT ON public.livestock_exception_log TO authenticated;

GRANT ALL ON public.master_livestock        TO service_role;
GRANT ALL ON public.trace_product_map       TO service_role;
GRANT ALL ON public.inbound_scans           TO service_role;
GRANT ALL ON public.stock_ledger            TO service_role;
GRANT ALL ON public.livestock_exception_log TO service_role;

-- 엑셀 업로드 큐는 재고에 직접 영향을 주지 않는 적재 단계다(실제 반영은
-- record_inbound_scan을 거친다). 수백 행을 RPC로 한 건씩 넣는 건 낭비라
-- 여기만 RLS 정책으로 직접 쓰기를 허용한다.
GRANT SELECT, INSERT, UPDATE ON public.inbound_import_jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.inbound_import_rows TO authenticated;
GRANT ALL ON public.inbound_import_jobs TO service_role;
GRANT ALL ON public.inbound_import_rows TO service_role;

CREATE POLICY "Import jobs writable by owner or org staff" ON public.inbound_import_jobs
    FOR INSERT WITH CHECK (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
    );

CREATE POLICY "Import jobs updatable by owner or org staff" ON public.inbound_import_jobs
    FOR UPDATE USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
    );

CREATE POLICY "Import rows writable via parent job" ON public.inbound_import_rows
    FOR INSERT WITH CHECK (
        job_id IN (
            SELECT id FROM public.inbound_import_jobs
            WHERE wholesaler_id = public.get_current_wholesaler_id()
               OR public.is_org_staff_of_wholesaler(wholesaler_id)
        )
    );

CREATE POLICY "Import rows updatable via parent job" ON public.inbound_import_rows
    FOR UPDATE USING (
        job_id IN (
            SELECT id FROM public.inbound_import_jobs
            WHERE wholesaler_id = public.get_current_wholesaler_id()
               OR public.is_org_staff_of_wholesaler(wholesaler_id)
        )
    );
