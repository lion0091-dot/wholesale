import type { Metadata } from "next";
import { AdminShell } from "@/components/admin-shell";
import { createClient } from "@/lib/supabase/server";
import { recordAccess } from "@/lib/security/access-log";

export const metadata: Metadata = { manifest: "/pwa/admin" };

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 관리자 화면 진입 접속기록 — 개인정보(공급사·입점 문의)를 볼 수 있는 영역이라 남긴다.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    await recordAccess(user.id, "admin_area_entry");
  }

  return <AdminShell>{children}</AdminShell>;
}
