"use server";

import { revalidatePath } from "next/cache";
import { ensureDevDefaultOrganization, type DevOrgResult } from "@/lib/auth/dev-org";

/**
 * 개발/테스트 환경에서 현재 계정을 기본 테스트 조직(Default Organization)에 연결한다.
 * 프로덕션 빌드에서는 ensureDevDefaultOrganization()이 항상 "disabled"를 반환한다.
 */
export async function linkDevDefaultOrganization(): Promise<DevOrgResult> {
  const result = await ensureDevDefaultOrganization();

  if (result.status === "linked" || result.status === "already-linked") {
    // 사이드바 조직명/역할 라벨과 미들웨어 조직 헤더를 갱신한다.
    revalidatePath("/dashboard", "layout");
  }

  return result;
}
