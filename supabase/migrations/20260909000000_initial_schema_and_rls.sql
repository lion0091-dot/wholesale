-- ====================================================================
-- PHASE 1: B2B Meat SaaS Initial Schema & Strict RLS Policies
-- ====================================================================

-- 1. PROFILES (auth.users와 1:1 매핑, 단일 Role 강제)
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('super_admin', 'wholesaler', 'retailer')),
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. WHOLESALERS (도매업자 업체 정보 및 폐쇄형 미니샵 토큰)
CREATE TABLE public.wholesalers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE RESTRICT,
    business_name TEXT NOT NULL,
    business_number TEXT NOT NULL UNIQUE,
    representative_name TEXT NOT NULL,
    shop_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
    subscription_status TEXT NOT NULL DEFAULT 'trial' CHECK (subscription_status IN ('trial', 'active', 'overdue', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. RETAILERS (소매 식당 정보)
CREATE TABLE public.retailers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE RESTRICT,
    restaurant_name TEXT NOT NULL,
    business_number TEXT,
    representative_name TEXT NOT NULL,
    delivery_address TEXT NOT NULL,
    delivery_address_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. WHOLESALER_RETAILERS (1:1 단골 거래처 관계)
CREATE TABLE public.wholesaler_retailers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    retailer_id UUID NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    memo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (wholesaler_id, retailer_id)
);

-- 5. PRODUCTS (육류 상품 정보 & 시크릿 딜)
CREATE TABLE public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    origin TEXT NOT NULL,
    grade TEXT,
    base_price NUMERIC(12, 2) NOT NULL CHECK (base_price >= 0),
    unit TEXT NOT NULL,
    stock_quantity NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    is_secret_deal BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. CUSTOM_PRICES (식당별 맞춤 VIP 단가)
CREATE TABLE public.custom_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    retailer_id UUID NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    custom_price NUMERIC(12, 2) NOT NULL CHECK (custom_price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (retailer_id, product_id)
);

-- 7. ORDERS (발주서 헤더)
CREATE TABLE public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE RESTRICT,
    retailer_id UUID NOT NULL REFERENCES public.retailers(id) ON DELETE RESTRICT,
    order_number TEXT NOT NULL UNIQUE,
    total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'shipping', 'delivered', 'cancelled')),
    delivery_address TEXT NOT NULL,
    delivery_notes TEXT,
    ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. ORDER_ITEMS (주문 품목 및 주문 시점 단가 스냅샷)
CREATE TABLE public.order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
    product_name TEXT NOT NULL,
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    quantity NUMERIC(10, 2) NOT NULL CHECK (quantity > 0),
    subtotal_amount NUMERIC(12, 2) NOT NULL CHECK (subtotal_amount >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ====================================================================
-- 인덱스 (조회 최적화)
-- ====================================================================
CREATE INDEX idx_wholesalers_token ON public.wholesalers(shop_token);
CREATE INDEX idx_products_wholesaler_active ON public.products(wholesaler_id, is_active);
CREATE INDEX idx_wholesaler_retailers_lookup ON public.wholesaler_retailers(wholesaler_id, retailer_id);
CREATE INDEX idx_orders_wholesaler_status ON public.orders(wholesaler_id, status);
CREATE INDEX idx_orders_retailer_date ON public.orders(retailer_id, ordered_at DESC);
CREATE INDEX idx_order_items_order ON public.order_items(order_id);

-- ====================================================================
-- RLS 보안 헬퍼 함수
-- ====================================================================
CREATE OR REPLACE FUNCTION public.get_current_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.get_current_wholesaler_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT id FROM public.wholesalers WHERE profile_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.get_current_retailer_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT id FROM public.retailers WHERE profile_id = auth.uid();
$$;

-- ====================================================================
-- 옵션 B 지원 함수: 비로그인 미니샵 카탈로그 안전 조회 (RPC)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.get_public_shop_catalog(p_shop_token UUID)
RETURNS TABLE (
    product_id UUID,
    name TEXT,
    category TEXT,
    origin TEXT,
    grade TEXT,
    base_price NUMERIC,
    unit TEXT,
    description TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT 
        p.id, p.name, p.category, p.origin, p.grade, p.base_price, p.unit, p.description
    FROM public.products p
    JOIN public.wholesalers w ON p.wholesaler_id = w.id
    WHERE w.shop_token = p_shop_token
      AND w.status = 'active'
      AND p.is_active = true
      AND p.is_secret_deal = false;
$$;

-- ====================================================================
-- ROW LEVEL SECURITY 활성화
-- ====================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wholesalers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retailers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wholesaler_retailers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

-- 1) PROFILES 정책
CREATE POLICY "Profiles viewable by self or admin" ON public.profiles
    FOR SELECT USING (id = auth.uid() OR public.get_current_role() = 'super_admin');
CREATE POLICY "Profiles insertable by self" ON public.profiles
    FOR INSERT WITH CHECK (id = auth.uid());
CREATE POLICY "Profiles updatable by self" ON public.profiles
    FOR UPDATE USING (id = auth.uid());

-- 2) WHOLESALERS 정책
CREATE POLICY "Wholesalers viewable by self, linked retailers, or admin" ON public.wholesalers
    FOR SELECT USING (
        profile_id = auth.uid() 
        OR public.get_current_role() = 'super_admin'
        OR id IN (SELECT wholesaler_id FROM public.wholesaler_retailers WHERE retailer_id = public.get_current_retailer_id() AND status = 'active')
    );
CREATE POLICY "Wholesalers insertable by self" ON public.wholesalers
    FOR INSERT WITH CHECK (profile_id = auth.uid());
CREATE POLICY "Wholesalers updatable by self or admin" ON public.wholesalers
    FOR UPDATE USING (profile_id = auth.uid() OR public.get_current_role() = 'super_admin');

-- 3) RETAILERS 정책
CREATE POLICY "Retailers viewable by self, linked wholesaler, or admin" ON public.retailers
    FOR SELECT USING (
        profile_id = auth.uid() 
        OR public.get_current_role() = 'super_admin'
        OR id IN (SELECT retailer_id FROM public.wholesaler_retailers WHERE wholesaler_id = public.get_current_wholesaler_id() AND status = 'active')
    );
CREATE POLICY "Retailers insertable by self" ON public.retailers
    FOR INSERT WITH CHECK (profile_id = auth.uid());
CREATE POLICY "Retailers updatable by self" ON public.retailers
    FOR UPDATE USING (profile_id = auth.uid());

-- 4) PRODUCTS 정책 (Vendor Isolation 핵심)
CREATE POLICY "Products viewable by owner, linked retailers, or admin" ON public.products
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.get_current_role() = 'super_admin'
        OR (
            is_active = true 
            AND wholesaler_id IN (
                SELECT wholesaler_id FROM public.wholesaler_retailers 
                WHERE retailer_id = public.get_current_retailer_id() AND status = 'active'
            )
        )
    );
CREATE POLICY "Products manageable by owner wholesaler" ON public.products
    FOR ALL USING (wholesaler_id = public.get_current_wholesaler_id());

-- 5) CUSTOM_PRICES 정책 (VIP 맞춤 단가 보안)
CREATE POLICY "Custom prices viewable by wholesaler or specific retailer" ON public.custom_prices
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR retailer_id = public.get_current_retailer_id()
        OR public.get_current_role() = 'super_admin'
    );
CREATE POLICY "Custom prices manageable by wholesaler" ON public.custom_prices
    FOR ALL USING (wholesaler_id = public.get_current_wholesaler_id());

-- 6) ORDERS 정책 (주문서 분리)
CREATE POLICY "Orders viewable by participating wholesaler or retailer" ON public.orders
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR retailer_id = public.get_current_retailer_id()
        OR public.get_current_role() = 'super_admin'
    );
CREATE POLICY "Orders insertable by linked retailer" ON public.orders
    FOR INSERT WITH CHECK (
        retailer_id = public.get_current_retailer_id()
        AND wholesaler_id IN (
            SELECT wholesaler_id FROM public.wholesaler_retailers 
            WHERE retailer_id = public.get_current_retailer_id() AND status = 'active'
        )
    );
CREATE POLICY "Orders updatable by wholesaler (status) or retailer (cancel)" ON public.orders
    FOR UPDATE USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR (retailer_id = public.get_current_retailer_id() AND status = 'pending')
    );

-- 7) ORDER_ITEMS 정책
CREATE POLICY "Order items viewable if parent order viewable" ON public.order_items
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.orders WHERE orders.id = order_items.order_id)
    );
CREATE POLICY "Order items insertable by parent order creator" ON public.order_items
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.orders 
            WHERE orders.id = order_items.order_id 
              AND orders.retailer_id = public.get_current_retailer_id()
        )
    );
