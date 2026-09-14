"use client";

import { useState } from "react";
import { ActiveAdminsList } from "./active-admins-list";
import { AdminCandidateSearch } from "./admin-candidate-search";
import type { AdminListEntry } from "./actions";

interface AdminAdminsClientProps {
  initialAdmins: AdminListEntry[];
  currentUserId: string;
}

/**
 * 관리자 목록 + 승격 검색을 하나의 admins state로 묶는 클라이언트 래퍼.
 *
 * page.tsx(서버 컴포넌트)가 최초 목록만 내려주고, 이후 승격/회수는 이 컴포넌트가
 * 로컬 state로 즉시 반영한다(전체 재조회 없이 낙관적 갱신).
 */
export function AdminAdminsClient({ initialAdmins, currentUserId }: AdminAdminsClientProps) {
  const [admins, setAdmins] = useState<AdminListEntry[]>(initialAdmins);

  return (
    <>
      <ActiveAdminsList
        admins={admins}
        currentUserId={currentUserId}
        onRevoked={(userId) => setAdmins((prev) => prev.filter((admin) => admin.id !== userId))}
      />
      <AdminCandidateSearch onPromoted={(entry) => setAdmins((prev) => [...prev, entry])} />
    </>
  );
}
