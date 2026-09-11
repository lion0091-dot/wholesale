# 🚀 CLAUDE.md - B2B Meat Mini-Shop (Stage 2) Implementation Prompt

> **Project Goal**: Implement Stage 2 (Phases 5–9) for the Closed 1:1 B2B Meat Order SaaS.
> **Target LLM/Agent**: Claude Code / High-level Developer AI
> **Frameworks & Infrastructure**: Next.js (App Router, TypeScript, Tailwind CSS), Supabase (PostgreSQL, Supabase Auth, Row Level Security), Vercel.

---

## 1. Project Philosophy & Core Constraints

1. **Closed 1:1 Walled Garden**: This is NOT an open marketplace or price-comparison site. Each Wholesaler (Supplier) operates an isolated mini-shop accessible only via tokenized/invited links to their regular Restaurants (Customers).
2. **Absolute Data Isolation (RLS)**: Supplier prices, custom VIP deals, and customer lists must NEVER leak to other suppliers or unauthorized buyers. RLS (Row Level Security) at the PostgreSQL level is non-negotiable.
3. **Role-Based Access Control (RBAC)**: Single accounts CANNOT hold both Supplier and Customer privileges simultaneously to prevent competitive espionage.
4. **Clean Code & Strict Typing**: Use TypeScript strict mode, Next.js Server Actions / App Router patterns, and Supabase Server Clients.

---

## 2. Tech Stack & Architecture

- **Frontend**: Next.js 14+ (App Router), TypeScript, Tailwind CSS, Lucide Icons, Shadcn UI
- **Backend / Database**: Supabase (PostgreSQL 15+)
- **Authentication**: Supabase Auth (JWT)
- **Security**: Supabase Row Level Security (RLS)
- **Document Export**: PDF Generation library (e.g., `jspdf` / `html2pdf.js` / `@react-pdf/renderer`) for Transaction Statements (거래명세서)

---

## 3. Database Schema (Stage 2 Extensions)

### Core Tables & DDL Specification

```sql
-- 1. Organizations (Suppliers / Wholesale Entities)
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    business_number VARCHAR(50) UNIQUE NOT NULL,
    representative_name VARCHAR(100),
    subscription_tier VARCHAR(20) DEFAULT 'pro' CHECK (subscription_tier IN ('lite', 'pro', 'enterprise')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Staff / Organization Profiles
CREATE TABLE organization_staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'staff' CHECK (role IN ('owner', 'manager', 'staff')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, user_id)
);

-- 3. Products
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    origin VARCHAR(100),
    base_price DECIMAL(12, 2) NOT NULL,
    purchase_price DECIMAL(12, 2), -- Actual cost for margin calculation
    unit VARCHAR(50) DEFAULT 'kg',
    is_secret_deal BOOLEAN DEFAULT FALSE,
    stock_quantity DECIMAL(10, 2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Custom Prices & Tiered Pricing (Tiered Discount / Min Quantity)
CREATE TABLE custom_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    custom_price DECIMAL(12, 2) NOT NULL,
    min_quantity DECIMAL(10, 2) DEFAULT 1, -- Minimum quantity for tiered pricing
    discount_rate DECIMAL(5, 2) DEFAULT 0, -- Percentage discount
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, customer_id, product_id, min_quantity)
);

-- 5. Orders & Order Items
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    total_amount DECIMAL(12, 2) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'shipping', 'completed', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    quantity DECIMAL(10, 2) NOT NULL,
    unit_price DECIMAL(12, 2) NOT NULL,
    subtotal DECIMAL(12, 2) NOT NULL
);
```

### Essential Row Level Security (RLS) Policies

```sql
-- Enable RLS on all tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Products: Supplier staff can manage, authorized customers can view
CREATE POLICY "Staff can manage own organization products" ON products
    FOR ALL USING (
        organization_id IN (
            SELECT organization_id FROM organization_staff WHERE user_id = auth.uid()
        )
    );

-- Custom Prices: Strictly isolated to specific supplier and assigned customer
CREATE POLICY "Customers can view their own custom prices" ON custom_prices
    FOR SELECT USING (customer_id = auth.uid());
```

---

## 4. Stage 2 Implementation Tasks (Phases 5 to 9)

### Phase 5: Supplier Organization & Staff Management (RBAC)
- [ ] Implement multi-user staff management under a single `organization_id`.
- [ ] Roles: `owner` (full control & billing), `manager` (product & order control), `staff` (view & process orders).
- [ ] Add invite system for new staff via email/link.

### Phase 6: Flexible Pricing & Discount Engine
- [ ] Implement `custom_prices` UI in Wholesaler Backoffice: set per-customer VIP prices.
- [ ] Implement **Tiered Quantity Pricing** (e.g., 5% extra discount when purchasing 10+ boxes).
- [ ] Support **Secret Deals (`is_secret_deal`)**: clearance items visible only to selected VIP customers.
- [ ] Auto-calculate expected margin (%) based on `purchase_price` vs `custom_price`.

### Phase 7: Analytics & Backoffice Intelligence
- [ ] Create Dashboard: Daily/Monthly revenue charts, top-selling meat cuts, customer revenue contribution rankings.
- [ ] Integrate Public Market Price Bar (e.g., 축산물품질평가원 public auction prices API) as reference-only data on the backoffice dashboard.

### Phase 8: Subscription Tier Feature Gating
- [ ] **Lite Plan**: Limit active customer connections (up to 20), core ordering features.
- [ ] **Pro Plan**: Full features, AI chatbot responses, custom pricing, unlimited customers.
- [ ] **Enterprise Plan**: Multi-staff RBAC, advanced analytics, dedicated support.

### Phase 9: Administrative & Transaction Statement Export
- [ ] **Transaction Statement (거래명세서) PDF Generator**: Instant PDF creation for completed orders.
- [ ] Order archive filtering by customer, date range, and product category.

---

## 5. Development Guidelines & Constraints for Claude Code

1. **Security First**: Every DB call must respect Supabase Auth context and RLS policies.
2. **No Data Leaks**: Never expose public price comparison endpoints across different suppliers.
3. **Responsive UI**: The buyer interface must be optimized for mobile web (KakaoTalk in-app browser compatible).
4. **Server Actions**: Use Next.js Server Actions for data mutations with proper input validation (Zod schema validation).
