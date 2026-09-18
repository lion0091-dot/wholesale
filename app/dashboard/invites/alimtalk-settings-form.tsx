"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import {
  saveAlimtalkSettingsAction,
  type AlimtalkSettingsStatus,
  type AlimtalkTemplateCodes,
} from "@/app/actions/alimtalk-settings";

interface AlimtalkSettingsFormProps {
  initial: AlimtalkSettingsStatus;
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

const TEMPLATE_FIELDS: Array<{ key: keyof AlimtalkTemplateCodes; label: string }> = [
  { key: "orderNew", label: "신규 발주 접수 알림" },
  { key: "cancelRequest", label: "주문 취소 요청 접수 알림" },
  { key: "creditExceeded", label: "여신 한도 초과 주문 거절 안내" },
  { key: "receivablesReminder", label: "미수금 정산 리마인드" },
];

/**
 * 공급사가 자기 비즈뿌리오(대행사) 계정으로 알림톡을 연동하는 설정 폼.
 *
 * 플랫폼은 이 설정을 대신 관리하지 않는다 — 공급사가 대행사와 1:1로 계약한 자기
 * 계정 정보를 직접 입력한다. 비밀번호는 절대 미리 채워 보여주지 않고(서버가 애초에
 * 내려주지 않음), 빈 칸으로 제출하면 기존에 저장된 값을 그대로 유지한다.
 */
export function AlimtalkSettingsForm({ initial }: AlimtalkSettingsFormProps) {
  const router = useRouter();
  const [account, setAccount] = useState(initial.account ?? "");
  const [password, setPassword] = useState("");
  const [senderKey, setSenderKey] = useState(initial.senderKey ?? "");
  const [senderPhone, setSenderPhone] = useState(initial.senderPhone ?? "");
  const [templateCodes, setTemplateCodes] = useState<AlimtalkTemplateCodes>(initial.templateCodes);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await saveAlimtalkSettingsAction({
        account,
        password,
        senderKey,
        senderPhone,
        templateCodes,
      });

      if (!result.success) {
        setError(result.error ?? "알림톡 설정 저장에 실패했습니다.");
        return;
      }

      setPassword("");
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
        {initial.configured ? "✓ 연동 설정됨" : "미설정 — 알림톡이 발송되지 않습니다"}
      </div>

      <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.7 }}>
        비즈뿌리오(bizppurio.com)에 직접 가입해 카카오톡 채널·발신프로필·알림톡 템플릿 승인을
        먼저 받으신 뒤, 여기에 그 계정 정보를 입력해주세요. 계약과 요금은 비즈뿌리오와 공급사님
        사이의 별도 계약이며, 플랫폼은 발송 연동만 대행합니다.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
        <div>
          <label htmlFor="alimtalk_account" style={labelStyle}>
            비즈뿌리오 계정
          </label>
          <input
            id="alimtalk_account"
            type="text"
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            placeholder="비즈뿌리오 로그인 계정"
            disabled={pending}
            style={fieldStyle}
          />
        </div>

        <div>
          <label htmlFor="alimtalk_password" style={labelStyle}>
            비즈뿌리오 비밀번호 {initial.configured && "(변경하지 않으려면 비워두세요)"}
          </label>
          <input
            id="alimtalk_password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={initial.configured ? "••••••••" : "비즈뿌리오 로그인 비밀번호"}
            autoComplete="new-password"
            disabled={pending}
            style={fieldStyle}
          />
        </div>

        <div>
          <label htmlFor="alimtalk_sender_key" style={labelStyle}>
            카카오톡 발신프로필키
          </label>
          <input
            id="alimtalk_sender_key"
            type="text"
            value={senderKey}
            onChange={(event) => setSenderKey(event.target.value)}
            placeholder="비즈뿌리오 발신프로필 관리 화면에서 확인"
            disabled={pending}
            style={fieldStyle}
          />
        </div>

        <div>
          <label htmlFor="alimtalk_sender_phone" style={labelStyle}>
            발신번호
          </label>
          <input
            id="alimtalk_sender_phone"
            type="tel"
            value={senderPhone}
            onChange={(event) => setSenderPhone(event.target.value)}
            placeholder="예: 0212345678"
            disabled={pending}
            style={fieldStyle}
          />
        </div>
      </div>

      <details>
        <summary style={{ fontSize: "12px", fontWeight: 700, color: "#334155", cursor: "pointer" }}>
          템플릿 코드 (카카오 승인 완료 후 입력)
        </summary>
        <div style={{ display: "grid", gap: "10px", marginTop: "10px" }}>
          {TEMPLATE_FIELDS.map(({ key, label }) => (
            <div key={key}>
              <label htmlFor={`template_${key}`} style={labelStyle}>
                {label}
              </label>
              <input
                id={`template_${key}`}
                type="text"
                value={templateCodes[key] ?? ""}
                onChange={(event) =>
                  setTemplateCodes((prev) => ({ ...prev, [key]: event.target.value }))
                }
                placeholder="승인된 템플릿 코드"
                disabled={pending}
                style={fieldStyle}
              />
            </div>
          ))}
        </div>
      </details>

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
