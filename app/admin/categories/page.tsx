import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { ensureSuperAdminBootstrap } from "@/lib/auth/super-admin-bootstrap";
import { CategoryManager } from "./category-manager";

export const metadata = { title: "상품 카테고리 관리 | 미트 파트너스" };

/** 플랫폼 공용 상품 카테고리 관리 — 슈퍼관리자 전용. 업체별이 아니라 전체 공급사가 공유한다. */
export default async function AdminCategoriesPage() {
  const isConfigured = isSupabaseConfigured();

  if (isConfigured) {
    const bootstrap = await ensureSuperAdminBootstrap();

    if (!bootstrap.isSuperAdmin && !(await isSuperAdminSession())) {
      redirect("/login?next=/admin/categories");
    }
  }

  let categories: Array<{ id: string; name: string }> = [];

  if (isConfigured) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("product_categories")
      .select("id, name")
      .order("sort_order", { ascending: true });

    categories = (data ?? []) as Array<{ id: string; name: string }>;
  }

  return (
    <main style={{ maxWidth: "480px", margin: "0 auto", padding: "24px 16px" }}>
      <Link href="/admin/suppliers" style={{ fontSize: "12px", color: "#64748b", textDecoration: "underline" }}>
        ← 공급사 관리로 이동
      </Link>
      <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: "8px 0 4px" }}>
        상품 카테고리 관리
      </h1>
      <p style={{ fontSize: "13px", color: "#64748b", marginBottom: "20px" }}>
        모든 공급사의 상품 등록 화면에서 공용으로 쓰이는 카테고리 목록입니다.
      </p>
      <CategoryManager initialCategories={categories} />
    </main>
  );
}
