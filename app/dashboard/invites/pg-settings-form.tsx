"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { savePgSettingsAction, type PgSettingsStatus } from "@/app/actions/pg-settings";

interface PgSettingsFormProps {
  initial: PgSettingsStatus;
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: "14px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 700,
  color: "#334155",
  marginBottom: "5px",
};

/**
 * 공급사가 자기 토스페이먼츠(PG) 계정으로 카드결제를 연동하는 설정 폼.
 *
 * 알림톡과 동일한 구조 — 플랫폼은 이 계정을 대신 관리하지 않는다. 시크릿키는 절대
 * 미리 채워 보여주지 않고(서버가 애초에 내려주지 않음), 빈 칸으로 제출하면 기존
 * 저장값을 그대로 유지한다.
 */
export function PgSettingsForm({ initial }: PgSettingsFormProps) {
  const router = useRouter();
  const [clientKey, setClientKey] = useState(initial.clientKey ?? "");
  const [secretKey, setSecretKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await savePgSettingsAction({ clientKey, secretKey });

      if (!result.success) {
        setError(result.error ?? "PG 설정 저장에 실패했습니다.");
        return;
      }

      setSecretKey("");
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div
        style={{
          display: "inline-flex",
          alignSelf: "flex-start",
          alignItems: "center",
          gap: "6px",
          fontSize: "11px",
          fontWeight: 700,
          padding: "3px 10px",
          borderRadius: "999px",
          backgroundColor: initial.configured ? "#dcfce7" : "#fef3c7",
          color: initial.configured ? "#166534" : "#92400e",
        }}
      >
        {initial.configured ? "✓ 연동 설정됨" : "미설정 — 고객이 PG 결제를 선택할 수 없습니다"}
      </div>

      <div
        style={{
          backgroundColor: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          padding: "12px 14px",
          fontSize: "12px",
          color: "#475569",
          lineHeight: 1.8,
        }}
      >
        <strong style={{ color: "#0f172a" }}>토스페이먼츠(tosspayments.com)</strong>에 직접
        가입해서 상점을 등록하면 개발자센터에서 클라이언트 키/시크릿 키를 발급받을 수
        있습니다. 계약과 수수료는 토스페이먼츠와 공급사님 사이의 별도 계약이며,
        플랫폼은 결제창 연동만 대행합니다. 발급받은 두 키를 아래에 입력하세요.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
        <div>
          <label htmlFor="pg_client_key" style={labelStyle}>
            클라이언트 키
          </label>
          <input
            id="pg_client_key"
            type="text"
            value={clientKey}
            onChange={(event) => setClientKey(event.target.value)}
            placeholder="test_ck_... / live_ck_..."
            disabled={pending}
            style={fieldStyle}
          />
        </div>

        <div>
          <label htmlFor="pg_secret_key" style={labelStyle}>
            시크릿 키 {initial.configured && "(변경하지 않으려면 비워두세요)"}
          </label>
          <input
            id="pg_secret_key"
            type="password"
            value={secretKey}
            onChange={(event) => setSecretKey(event.target.value)}
            placeholder={initial.configured ? "••••••••" : "test_sk_... / live_sk_..."}
            autoComplete="new-password"
            disabled={pending}
            style={fieldStyle}
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        style={{
          alignSelf: "flex-start",
          padding: "10px 18px",
          fontSize: "14px",
          fontWeight: 700,
          color: "#ffffff",
          backgroundColor: pending ? "#94a3b8" : "#0f172a",
          border: "none",
          borderRadius: "8px",
          cursor: pending ? "wait" : "pointer",
        }}
      >
        {pending ? "저장 중..." : "저장"}
      </button>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", lineHeight: 1.6 }}>
          {error}
        </p>
      )}

      {saved && !error && (
        <p style={{ fontSize: "12px", color: "#166534", lineHeight: 1.6 }}>✓ 저장되었습니다.</p>
      )}
    </form>
  );
}
