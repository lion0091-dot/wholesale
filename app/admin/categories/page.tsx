import { redirect } from "next/navigation";
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

  let categories: Array<{
    id: string;
    name: string;
    subcategories: Array<{ id: string; name: string }>;
  }> = [];

  if (isConfigured) {
    const supabase = await createClient();
    const [{ data: categoryRows }, { data: subcategoryRows }] = await Promise.all([
      supabase.from("product_categories").select("id, name").order("sort_order", { ascending: true }),
      supabase
        .from("product_subcategories")
        .select("id, name, category_id")
        .order("sort_order", { ascending: true }),
    ]);

    const subcategoriesByCategoryId = new Map<string, Array<{ id: string; name: string }>>();

    for (const row of (subcategoryRows ?? []) as Array<{ id: string; name: string; category_id: string }>) {
      const list = subcategoriesByCategoryId.get(row.category_id) ?? [];
      list.push({ id: row.id, name: row.name });
      subcategoriesByCategoryId.set(row.category_id, list);
    }

    categories = ((categoryRows ?? []) as Array<{ id: string; name: string }>).map((category) => ({
      ...category,
      subcategories: subcategoriesByCategoryId.get(category.id) ?? [],
    }));
  }

  return (
    <div style={{ maxWidth: "480px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: "8px 0 4px" }}>
        상품 카테고리 관리
      </h1>
      <p style={{ fontSize: "13px", color: "#64748b", marginBottom: "20px" }}>
        모든 공급사의 상품 등록 화면에서 공용으로 쓰이는 카테고리 목록입니다.
      </p>
      <CategoryManager initialCategories={categories} />
    </div>
  );
}
