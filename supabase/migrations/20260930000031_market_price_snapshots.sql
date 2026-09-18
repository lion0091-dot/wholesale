-- 축산물품질평가원(KAPE) 공공 경락가격 API를 하루 1회 크론으로 긁어와 캐싱하는 테이블.
-- ROADMAP §1 "축산물품질평가원 공공 시세 API 연동" — 공급사가 원매가(매입가) 입력란
-- 옆에서 오늘 도매 평균 경락가를 참고용으로 비교할 수 있게 하는 게 목적.
--
-- 업체별 데이터가 아니라 플랫폼 공용 시세 데이터라 wholesaler_id 없음(product_categories와
-- 동일 패턴). 쓰기는 크론(service_role, RLS 우회)만 하므로 쓰기 정책은 두지 않는다.
create table public.market_price_snapshots (
    id            uuid primary key default gen_random_uuid(),
    -- 'cattle' | 'pig' — API 축종 코드가 아니라 우리 쪽에서 정규화한 값
    species       text not null check (species in ('cattle', 'pig')),
    -- 등급 표기는 축종마다 체계가 달라(예: 1++/1+/1/2/등외, 또는 돼지 성별+등급 조합) 자유
    -- 텍스트로 둔다. 원본 API 응답 그대로 정규화해서 저장.
    grade         text not null,
    -- 지역 단위 데이터도 있어 대비해두되, 전국 평균은 'national' 고정값 사용
    -- (NULL은 유니크 제약에서 다르게 취급돼 문제가 생기므로 sentinel 값으로 둠).
    region        text not null default 'national',
    price_per_kg  numeric not null,
    -- 두수(표본 수) — 없는 오퍼레이션도 있어 nullable
    unit_count    integer,
    snapshot_date date not null,
    -- 원본 API 오퍼레이션명 기록 (예: pigJejuGrade) — 나중에 데이터 출처 추적/디버깅용
    source        text not null,
    created_at    timestamptz not null default now(),
    unique (species, grade, region, snapshot_date)
);

create index market_price_snapshots_lookup_idx
    on public.market_price_snapshots (species, grade, region, snapshot_date desc);

alter table public.market_price_snapshots enable row level security;

-- 상품 등록/발주 화면에서 시세 위젯을 보여주려면 모든 로그인 사용자가 읽을 수 있어야 한다.
create policy "Market price snapshots viewable by authenticated" on public.market_price_snapshots
    for select
    to authenticated
    using (true);
