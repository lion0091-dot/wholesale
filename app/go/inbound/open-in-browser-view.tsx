"use client";

import { useEffect, useState } from "react";

type Environment = "checking" | "kakao" | "other-inapp" | "browser";

/**
 * 카카오톡 인앱 브라우저는 UA에 KAKAOTALK을 넣는다.
 * 다른 앱(네이버·인스타·라인 등)의 인앱 브라우저는 앱마다 표기가 달라
 * 대표적인 것만 본다 — 못 잡아도 안내 화면으로 빠질 뿐이라 위험하지 않다.
 */
function detectEnvironment(userAgent: string): Exclude<Environment, "checking"> {
  const ua = userAgent.toUpperCase();

  if (ua.includes("KAKAOTALK")) {
    return "kakao";
  }

  if (/NAVER|INSTAGRAM|FBAN|FBAV|LINE\//.test(ua)) {
    return "other-inapp";
  }

  return "browser";
}

interface Props {
  /** 최종 목적지 (앱 내부 경로) */
  target: string;
}

export function OpenInBrowserView({ target }: Props) {
  const [environment, setEnvironment] = useState<Environment>("checking");
  const [absoluteUrl, setAbsoluteUrl] = useState("");

  useEffect(() => {
    const url = `${window.location.origin}${target}`;
    setAbsoluteUrl(url);

    const detected = detectEnvironment(window.navigator.userAgent);
    setEnvironment(detected);

    if (detected === "browser") {
      // 이미 일반 브라우저다 — 중간 화면을 보여줄 이유가 없다.
      // replace를 쓰면 뒤로가기가 이 페이지로 되돌아오지 않는다.
      window.location.replace(target);
      return;
    }

    if (detected === "kakao") {
      // 카카오톡이 제공하는 "기본 브라우저로 열기" 스킴. iOS·안드로이드 공통이다.
      // 동작하지 않아도 아래 안내 화면이 그대로 남아 수동으로 열 수 있다.
      window.location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
    }
  }, [target]);

  if (environment === "checking") {
    return <Shell>여는 중…</Shell>;
  }

  if (environment === "browser") {
    return <Shell>입고 화면으로 이동 중…</Shell>;
  }

  return (
    <Shell>
      <h1 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: "0 0 8px" }}>
        브라우저에서 열어주세요
      </h1>

      <p style={{ fontSize: "14px", color: "#475569", lineHeight: 1.6, margin: "0 0 16px" }}>
        {environment === "kakao"
          ? "카카오톡 안에서는 카메라 바코드 스캔이 동작하지 않습니다. 잠시 후 기본 브라우저가 자동으로 열립니다."
          : "이 앱의 내장 브라우저에서는 카메라 바코드 스캔이 동작하지 않습니다."}
      </p>

      <ol style={{ fontSize: "13px", color: "#475569", lineHeight: 1.8, paddingLeft: "18px", margin: "0 0 16px" }}>
        <li>브라우저가 자동으로 안 열리면 화면 오른쪽 아래(또는 위) <strong>⋯ 메뉴</strong>를 누르세요.</li>
        <li><strong>“다른 브라우저로 열기”</strong> 또는 <strong>“Chrome으로 열기”</strong>를 선택하세요.</li>
      </ol>

      {absoluteUrl && (
        <a
          href={absoluteUrl}
          style={{
            display: "block",
            textAlign: "center",
            padding: "12px",
            borderRadius: "8px",
            backgroundColor: "#0f172a",
            color: "#fff",
            fontSize: "14px",
            fontWeight: 700,
            textDecoration: "none",
            marginBottom: "16px",
          }}
        >
          입고 화면 열기
        </a>
      )}

      <div
        style={{
          border: "1px solid #e2e8f0",
          backgroundColor: "#f8fafc",
          borderRadius: "8px",
          padding: "12px 14px",
        }}
      >
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>
          매번 이러기 번거로우시면
        </div>
        <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.6, margin: 0 }}>
          브라우저로 열린 뒤 <strong>메뉴 → “홈 화면에 추가”</strong>를 한 번만 해두세요. 다음부터는 폰 바탕화면
          아이콘으로 바로 들어오고, 로그인도 유지됩니다.
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        backgroundColor: "#f8fafc",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "420px",
          backgroundColor: "#fff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "20px",
          fontSize: "14px",
          color: "#475569",
        }}
      >
        {children}
      </div>
    </main>
  );
}
