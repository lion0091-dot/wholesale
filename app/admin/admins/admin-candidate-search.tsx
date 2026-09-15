"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  promoteAdminAction,
  searchAdminCandidatesAction,
  type AdminCandidate,
  type AdminListEntry,
} from "./actions";

interface AdminCandidateSearchProps {
  /** 승격 성공 시 목록에 즉시 반영할 콜백 (page.tsx가 관리자 목록 state를 들고 있음) */
  onPromoted: (entry: AdminListEntry) => void;
}

/**
 * 관리자 승격 후보 검색 + 승격 UI.
 *
 * 이메일 사전등록을 지원하지 않으므로(CLAUDE.md 잠긴 설계 결정) "이미 로그인한
 * 계정"만 이름/전화로 검색해서 승격할 수 있다. 승격 시 can_grant(명단 편집
 * 권한까지 줄지)를 체크박스로 선택한다 — 기본값은 false(일반 관리자).
 */
export function AdminCandidateSearch({ onPromoted }: AdminCandidateSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminCandidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [canGrantByRow, setCanGrantByRow] = useState<Record<string, boolean>>({});
  const [isSearching, startSearch] = useTransition();

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    startSearch(async () => {
      const result = await searchAdminCandidatesAction(query);

      setSearched(true);

      if (!result.success) {
        setError(result.error ?? "검색에 실패했습니다.");
        setResults([]);
        return;
      }

      setResults(result.data ?? []);
    });
  };

  const handlePromote = async (candidate: AdminCandidate) => {
    const canGrant = canGrantByRow[candidate.id] ?? false;

    if (
      !confirm(
        `${candidate.name} 계정을 관리자로 승격할까요?${
          canGrant ? "\n(다른 관리자를 승격/회수할 수 있는 권한까지 부여됩니다)" : ""
        }`
      )
    ) {
      return;
    }

    setBusyId(candidate.id);
    setPromoteError(null);

    try {
      const result = await promoteAdminAction({ userId: candidate.id, canGrant });

      if (!result.success) {
        setPromoteError(result.error ?? "승격에 실패했습니다.");
        return;
      }

      setResults((prev) => prev.filter((item) => item.id !== candidate.id));
      onPromoted({
        id: candidate.id,
        name: candidate.name,
        phone: candidate.phone,
        canGrant,
        source: "admin_grant",
        createdAt: new Date().toISOString(),
      });
    } catch {
      setPromoteError("오류가 발생했습니다.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section style={{ marginTop: "28px" }}>
      <h2 style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a", marginBottom: "10px" }}>
        관리자 승격
      </h2>

      <p style={{ fontSize: "12px", color: "#64748b", marginBottom: "10px", lineHeight: 1.6 }}>
        이름 또는 전화번호로 검색합니다. 최소 한 번 로그인한 계정만 검색됩니다(이메일 사전등록 미지원).
        행정 승인이 끝난 공급사·입점 신청 중인 계정은 검색 결과에서 제외됩니다.
      </p>

      <form onSubmit={handleSearch} style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="이름 또는 전화번호 (2자 이상)"
          style={{
            flex: 1,
            padding: "10px 12px",
            fontSize: "14px",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
          }}
        />
        <button
          type="submit"
          disabled={isSearching}
          style={{
            backgroundColor: "#0f172a",
            color: "#ffffff",
            fontSize: "13px",
            fontWeight: 700,
            padding: "10px 18px",
            borderRadius: "8px",
            border: "none",
            cursor: isSearching ? "not-allowed" : "pointer",
          }}
        >
          {isSearching ? "검색 중..." : "검색"}
        </button>
      </form>

      {error && (
        <div
          role="alert"
          style={{
            backgroundColor: "#fee2e2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: "13px",
            padding: "10px 12px",
            borderRadius: "8px",
            marginBottom: "12px",
          }}
        >
          {error}
        </div>
      )}

      {promoteError && (
        <div
          role="alert"
          style={{
            backgroundColor: "#fee2e2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: "13px",
            padding: "10px 12px",
            borderRadius: "8px",
            marginBottom: "12px",
          }}
        >
          {promoteError}
        </div>
      )}

      {searched && results.length === 0 && !error && (
        <div
          style={{
            backgroundColor: "#ffffff",
            borderRadius: "12px",
            border: "1px dashed #cbd5e1",
            padding: "24px 16px",
            textAlign: "center",
            color: "#64748b",
            fontSize: "13px",
          }}
        >
          검색 결과가 없습니다.
        </div>
      )}

      {results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {results.map((candidate) => {
            const isBusy = busyId === candidate.id;
            const canGrant = canGrantByRow[candidate.id] ?? false;

            return (
              <div
                key={candidate.id}
                style={{
                  backgroundColor: "#ffffff",
                  borderRadius: "10px",
                  border: "1px solid #e2e8f0",
                  padding: "14px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "10px",
                  opacity: isBusy ? 0.6 : 1,
                }}
              >
                <div>
                  <span style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                    {candidate.name}
                  </span>
                  <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                    {candidate.phone || "연락처 미등록"} · 현재 role: {candidate.role}
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "12px",
                      color: "#475569",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={canGrant}
                      disabled={isBusy}
                      onChange={(event) =>
                        setCanGrantByRow((prev) => ({ ...prev, [candidate.id]: event.target.checked }))
                      }
                    />
                    명단 편집 권한도 부여
                  </label>

                  <button
                    disabled={isBusy}
                    onClick={() => handlePromote(candidate)}
                    style={{
                      backgroundColor: "#16a34a",
                      color: "#ffffff",
                      fontSize: "12px",
                      fontWeight: 700,
                      padding: "6px 14px",
                      borderRadius: "6px",
                      border: "none",
                      cursor: isBusy ? "not-allowed" : "pointer",
                    }}
                  >
                    {isBusy ? "처리 중..." : "관리자로 승격"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
