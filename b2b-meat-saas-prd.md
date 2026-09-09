# [Comprehensive Product Specification & Business Logic] Private B2B Meat Order SaaS

## 1. Project Overview & Core Philosophy
- **Product Definition:** An exclusive, private 1:1 mobile ordering SaaS tool for individual meat wholesalers and their regular restaurant (retail) clients. 
- **Not an Open Marketplace:** This is NOT an open platform where buyers compare prices across different wholesalers. It is a closed, walled-garden tool designed to digitize existing offline relationships and lock in regular clients.
- **Key Defensive Strategy:** Prevent "major regular client flight fear" by strictly isolating vendor spaces. Wholesalers must feel secure that their VIP clients cannot see competitors or compare baseline prices. Features include **custom/VIP per-client pricing** and flexibility to keep ultra-large VIPs on traditional channels while using the SaaS to capture secondary/frequent small orders and clearance inventory.

## 2. User Roles, Permissions, & Account Separation (RBAC)
- **Strict Separation:** A single account CANNOT have both wholesaler and retailer privileges simultaneously to prevent competitive espionage (e.g., a wholesaler logging in as a buyer to spy on rival prices). If a wholesaler needs to purchase from another vendor, they must use a completely separate retail account.
- **Wholesaler (Seller):** Pays a sustainable SaaS subscription (Targeting **150,000 to 200,000 KRW/month** after an initial trial/promo period to cover infrastructure, messaging, and operational margins). Manages inventory, sets custom/VIP pricing, generates exclusive store links, and processes orders.
- **Retailer (Buyer - Restaurant):** 100% free to use. Accesses mini-shops exclusively via unique invitation links shared by their specific wholesaler via KakaoTalk.
- **Super Admin (Platform Owner):** 
  - Retained permanently post-launch for business operations.
  - Responsibilities include approving new wholesaler sign-ups (verifying business registration certificates), managing subscription statuses/access control, handling high-tier troubleshooting/disputes, and enforcing platform security/bans.
  - **Testing & Cleanup:** During the development and pre-launch testing phase, the developer utilizes a Super Admin account with dual-testing capabilities, scheduled for a complete database clean-up (hard reset) right before official public go-live.

## 3. Key Features & Business Logic
- **Mini-Shop Architecture:** Dynamic routing where a unique token/URL renders only a specific wholesaler's inventory. 
- **Secret/Clearance Deal Room (`is_secret_deal`):** A hidden or special tab within the private mini-shop allowing wholesalers to dump surplus/expiring inventory exclusively to their invited regulars without breaking public market pricing.
- **Order & Notification Flow:** Cart-based ordering by the restaurant -> Instant trigger of Kakao Notification Talk (AlimTalk) to the wholesaler.
- **Automated Chat Support (AI Integration):** Planned integration with Kakao chatbot webhooks connected to lightweight LLMs (e.g., GPT-4o mini) to handle routine customer inquiries (stock checks, delivery status, basic pricing) automatically, mitigating manual response burdens.

## 4. Technical Stack & Infrastructure (Zero-Cost Hosting MVP)
- **Frontend / Hosting:** Vercel (Free Tier, Next.js/React responsive mobile web).
- **Backend / Database / Auth:** Supabase (Free Tier, PostgreSQL).
- **Security Implementation (Zero Additional Cost for Setup):**
  - Authentication handled entirely by Supabase Auth (JWT, secure hashing).
  - Row Level Security (RLS) enforced at the database level to block unauthorized cross-vendor data access.
  - HTTPS enforced by default via hosting platforms.
  - No sensitive financial data stored locally (external PG handling payments like Toss).
- **Messaging Costs:** Kakao AlimTalk incurs nominal costs (~8-10 KRW per message) during live usage, but near zero during initial testing.

## 5. Legal & Regulatory Compliance
- **Footer Disclosures:** Mandatory display of platform operator business registration, e-commerce registration (통신판매업 신고번호), customer service contacts, privacy officer details, and links to Terms of Service and Privacy Policy.
- **Escrow & Security Badges:** Standard PG escrow service notification seals and SSL encryption notices.
- **Vendor-Level Disclosure:** Each mini-shop must display the respective wholesaler's legal business information and platform intermediary disclaimers.

## 6. Post-Launch Operational Architecture (Human-in-the-Loop & AI Separation)
- **Coding Agents vs. Runtime Agents:** Strict separation between development AI agents (used strictly pre-launch for code generation, DB migration, and architecture design) and runtime operational AI agents.
- **Operational Division of Labor:**
  - **Rule-Based Systems (Code/Database):** Handles high-precision, uncompromised tasks such as monetary transactions, cart checkout, stock deductions, and strict database RLS access control.
  - **AI Runtime Operational Agent (CS Support):** Functions as a background chatbot (via Kakao webhooks and lightweight LLM APIs) to handle unstructured routine inquiries (e.g., daily market rates, delivery tracking) by querying the live DB safely.
  - **Human Super Admin (Human-in-the-Loop):** Retains final authority over critical business operations including new wholesaler application approvals, subscription governance, dispute resolution, and regulatory compliance oversight.

## 7. MVP Scope Boundaries & Staged Execution Plan
- **Staged Phased Execution (To prevent agent hallucination & scope creep):**
  1. **Phase 1:** Database schema design & Supabase RLS strict security policies.
  2. **Phase 2:** Basic CRUD for products & token-based dynamic mini-shop rendering.
  3. **Phase 3:** Cart, order placement, and Kakao AlimTalk notification triggers.
  4. **Phase 4:** Super Admin approval workflows, system-wide cleanup scripts, and footer legal compliance templates.
- **Excluded (Post-MVP / Future):** AI OCR for paper price tags/receipts, automated tax invoicing, multi-vendor search, and full-scale autonomous multi-agent systems.