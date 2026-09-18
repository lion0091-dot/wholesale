-- PG(토스페이먼츠) 결제 연동 + 고객별 결제수단 허용목록.
--
-- 알림톡과 동일한 구조: 플랫폼은 파트너 계약 없이 순수 기술 연동만 하고, 공급사가
-- 토스페이먼츠와 개별 가맹계약을 맺어 자기 클라이언트키/시크릿키를 우리 설정 화면에
-- 입력한다. 시크릿키는 비밀번호와 동일한 민감도라 alimtalk_password_encrypted와
-- 같은 방식(AES-256-GCM, lib/security/credential-crypto.ts)으로 암호화 저장한다.
--
-- SQL Editor에서 재실행해도 안전하도록 전부 IF NOT EXISTS / DROP...IF EXISTS 가드를 둔다
-- (한 번 부분 적용된 뒤 재시도하는 경우 대비).

-- 1) 공급사별 PG 자격정보
alter table public.wholesalers
    add column if not exists pg_provider           text,
    add column if not exists pg_client_key         text,
    add column if not exists pg_secret_key_encrypted text;

-- 2) 고객(거래처)별 허용 결제수단. 기본값은 기존 동작과 동일하게 '직접정산만 허용'
-- (외상은 credit_limit>0일 때만 실제로 쓸 수 있다는 기존 규칙은 애플리케이션
-- 레이어에서 계속 이중으로 검증한다 — 이 배열은 "공급사가 이 방식을 열어줬는가"만
-- 나타내고, "지금 실제로 쓸 수 있는가"의 전체 조건은 아니다).
alter table public.wholesaler_retailers
    add column if not exists allowed_payment_methods text[] not null default array['prepaid'];

-- 3) orders: PG 결제 상태 추적. prepaid/on_credit 주문은 이 컬럼들을 쓰지 않는다
-- (우리가 자금에 관여하지 않으므로 NULL로 남음) — pg 결제 주문만 unpaid로 시작해서
-- 승인 성공 시 paid, 취소 승인 시(자동환불 성공 후) refunded로 바뀐다.
alter table public.orders
    add column if not exists payment_status text check (payment_status in ('unpaid', 'paid', 'refunded')),
    add column if not exists pg_payment_key text,
    add column if not exists pg_order_id   text;

alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
    check (payment_method in ('prepaid', 'on_credit', 'pg'));

-- 4) 결제 승인 전 임시 저장소. "결제 확정 후에만 실제 주문 생성" 원칙 때문에 필요하다
-- (결제 도중 이탈해도 공급사에게 유령 주문 알림이 가지 않게 하기 위함). 장바구니
-- 스냅샷을 여기 저장해뒀다가, 토스 승인 API가 성공한 뒤에야 orders/order_items로
-- 옮겨 심는다. 만료(30분) 지난 행은 크론 없이 조회 시점에 그냥 무시한다(정리 배치는
-- 필요해지면 나중에 추가 — 지금은 재고/락 문제가 없는 순수 메타데이터라 방치해도 무해).
create table if not exists public.pg_pending_payments (
    id               uuid primary key default gen_random_uuid(),
    pg_order_id      text not null unique,
    wholesaler_id    uuid not null references public.wholesalers(id) on delete cascade,
    retailer_id      uuid not null references public.retailers(id) on delete cascade,
    total_amount     numeric(12, 2) not null check (total_amount > 0),
    cart_snapshot    jsonb not null,
    restaurant_name  text not null,
    contact_phone    text not null,
    delivery_address text not null,
    delivery_notes   text,
    created_at       timestamptz not null default now(),
    expires_at       timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists idx_pg_pending_payments_wholesaler on public.pg_pending_payments(wholesaler_id);
create index if not exists idx_pg_pending_payments_retailer on public.pg_pending_payments(retailer_id);

alter table public.pg_pending_payments enable row level security;

drop policy if exists "Pending PG payments insertable by linked retailer" on public.pg_pending_payments;
create policy "Pending PG payments insertable by linked retailer" on public.pg_pending_payments
    for insert
    with check (
        retailer_id = public.get_current_retailer_id()
        and wholesaler_id in (
            select wholesaler_id from public.wholesaler_retailers
             where retailer_id = public.get_current_retailer_id() and status = 'active'
        )
    );

drop policy if exists "Pending PG payments viewable by buyer or supplier" on public.pg_pending_payments;
create policy "Pending PG payments viewable by buyer or supplier" on public.pg_pending_payments
    for select using (
        retailer_id = public.get_current_retailer_id()
        or wholesaler_id = public.get_current_wholesaler_id()
        or public.get_current_role() = 'super_admin'
    );

drop policy if exists "Pending PG payments deletable by buyer" on public.pg_pending_payments;
create policy "Pending PG payments deletable by buyer" on public.pg_pending_payments
    for delete using (retailer_id = public.get_current_retailer_id());
