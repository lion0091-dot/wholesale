import { createClient } from "@/lib/supabase/server";
import { getOrgStaffContext, type OrgRole } from "@/lib/auth/rbac";
import type { UserRole } from "@/types/database";

export interface SupplierScope {
  userId: string;
  organizationId: string | null;
  orgRole: OrgRole | null;
  platformRole: UserRole | null;
  isSuperAdmin: boolean;
  /** 레거시 wholesalers.id — 상품/발주/단가 데이터의 실제 스코프 키 */
  wholesalerId: string | null;
  businessName: string;
  shopToken: string | null;
}

/**
 * 백오피스 Server Component에서 공통으로 쓰는 공급사 스코프 조회.
 * 미인증(데모 모드)이면 null을 반환하므로 호출부에서 샘플 데이터로 대체한다.
 */
export async function getSupplierScope(): Promise<SupplierScope | null> {
  const context = await getOrgStaffContext();

  if (!context) {
    return null;
  }

  const supabase = await createClient();
  let wholesalerId: string | null = null;

  if (context.organizationId) {
    const { data: organization } = await supabase
      .from("organizations")
      .select("wholesaler_id")
      .eq("id", context.organizationId)
      .maybeSingle();

    wholesalerId = (organization?.wholesaler_id as string | null) ?? null;
  }

  const { data: wholesaler } = wholesalerId
    ? await supabase
        .from("wholesalers")
        .select("id, business_name, shop_token")
        .eq("id", wholesalerId)
        .maybeSingle()
    : await supabase
        .from("wholesalers")
        .select("id, business_name, shop_token")
        .eq("profile_id", context.userId)
        .maybeSingle();

  return {
    userId: context.userId,
    organizationId: context.organizationId,
    orgRole: context.orgRole,
    platformRole: context.platformRole,
    isSuperAdmin: context.isSuperAdmin,
    wholesalerId: (wholesaler?.id as string | undefined) ?? wholesalerId,
    businessName: (wholesaler?.business_name as string | undefined) ?? "공급사 백오피스",
    shopToken: (wholesaler?.shop_token as string | undefined) ?? null,
  };
}
