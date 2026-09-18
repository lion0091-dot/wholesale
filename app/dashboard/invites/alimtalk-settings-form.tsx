"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import {
  saveAlimtalkSettingsAction,
  type AlimtalkSettingsStatus,
  type AlimtalkTemplateCodes,
} from "@/app/actions/alimtalk-settings";
import {
  ALIMTALK_TEMPLATE_REFERENCE_TEXT,
  type AlimtalkTemplateKey,
} from "@/lib/notifications/alimtalk-templates";

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

const TEMPLATE_KEYS: AlimtalkTemplateKey[] = [
  "orderNew",
  "cancelRequest",
  "creditExceeded",
  "receivablesReminder",
  "creditLimitIncreased",
  "creditLimitExceededRetailer",
  "creditLimitChangedWholesaler",
  "retailerBlocked",
  "retailerBlockedRetailer",
  "retailerResumed",
  "retailerResumedRetailer",
];

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

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
  const [copiedTemplateKey, setCopiedTemplateKey] = useState<AlimtalkTemplateKey | null>(null);
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

      {!initial.configured && (
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
          <strong style={{ color: "#0f172a" }}>사이트 두 곳을 순서대로 거쳐야 합니다</strong> (비즈뿌리오
          한 곳에서 전부 되는 게 아닙니다):
          <ol style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
            <li>
              <strong>카카오 비즈니스 채널 관리자센터</strong>(center-pf.kakao.com)에서 카카오톡 채널을
              먼저 개설 — 이건 비즈뿌리오 가입과 무관하게 카카오 사이트에서 직접 합니다. 채널 개설/
              비즈니스 인증 과정에서 발송할 메시지 내용을 요구하면 아래 {TEMPLATE_KEYS.length}개
              문구를 복사해서 제출하세요.
              <ul style={{ margin: "6px 0 0", paddingLeft: "16px", display: "flex", flexDirection: "column", gap: "6px" }}>
                {TEMPLATE_KEYS.map((key) => {
                  const reference = ALIMTALK_TEMPLATE_REFERENCE_TEXT[key];

                  return (
                    <li key={key} style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <span>{reference.title}</span>
                      <button
                        type="button"
                        onClick={() => {
                          void copyText(reference.text).then(() => {
                            setCopiedTemplateKey(key);
                            setTimeout(
                              () => setCopiedTemplateKey((current) => (current === key ? null : current)),
                              2500
                            );
                          });
                        }}
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          color: copiedTemplateKey === key ? "#166534" : "#2563eb",
                          background: "none",
                          border: "1px solid #bfdbfe",
                          borderRadius: "6px",
                          padding: "2px 8px",
                          cursor: "pointer",
                        }}
                      >
                        {copiedTemplateKey === key ? "✓ 복사됨" : "문구 복사"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
            <li>
              <strong>비즈뿌리오(bizppurio.com)</strong>에 가입해서, 위에서 만든 채널로 발신프로필을
              등록하고 위 템플릿 {TEMPLATE_KEYS.length}개를 심사 신청합니다.
            </li>
            <li>승인이 끝나면 아래 계정 정보와 템플릿 코드를 여기에 입력하시면 됩니다.</li>
          </ol>
          계약과 요금은 비즈뿌리오와 공급사님 사이의 별도 계약이며, 플랫폼은 발송 연동만 대행합니다.
        </div>
      )}

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
        <div style={{ display: "grid", gap: "16px", marginTop: "10px" }}>
          {TEMPLATE_KEYS.map((key) => {
            const reference = ALIMTALK_TEMPLATE_REFERENCE_TEXT[key];

            return (
              <div key={key} style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                  {reference.title}
                </div>

                <p style={{ fontSize: "11px", color: "#94a3b8", marginBottom: "6px", lineHeight: 1.6 }}>
                  아래 문구를 그대로 복사해서 비즈뿌리오 &quot;알림톡 템플릿 관리&quot; 화면에 심사
                  신청하세요. 승인받으면 나온 템플릿 코드를 밑에 입력합니다.
                </p>

                <pre
                  style={{
                    fontSize: "11px",
                    color: "#334155",
                    backgroundColor: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: "6px",
                    padding: "10px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "keep-all",
                    fontFamily: "inherit",
                  }}
                >
                  {reference.text}
                </pre>

                <button
                  type="button"
                  onClick={() => {
                    void copyText(reference.text).then(() => {
                      setCopiedTemplateKey(key);
                      setTimeout(() => setCopiedTemplateKey((current) => (current === key ? null : current)), 2500);
                    });
                  }}
                  style={{
                    marginTop: "6px",
                    marginBottom: "10px",
                    fontSize: "11px",
                    fontWeight: 700,
                    color: copiedTemplateKey === key ? "#166534" : "#2563eb",
                    background: "none",
                    border: "1px solid #bfdbfe",
                    borderRadius: "6px",
                    padding: "5px 10px",
                    cursor: "pointer",
                  }}
                >
                  {copiedTemplateKey === key ? "✓ 복사됨" : "문구 복사"}
                </button>

                <label htmlFor={`template_${key}`} style={labelStyle}>
                  승인된 템플릿 코드
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
            );
          })}
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
