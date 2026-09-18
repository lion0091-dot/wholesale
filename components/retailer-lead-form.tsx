"use client";

import { useState } from "react";
import { submitRetailerMatchRequestAction } from "@/app/actions/retailer-match-request";

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
 * 대문 "고객사(식당) 입점 희망" 신청 폼. 로그인 없이 누구나 제출 가능 — 아직 우리
 * 시스템 계정이 없는 식당 사장님이 대상이다. 알고리즘 매칭이 아니라 접수된 내용을
 * 관리자가 보고 적합한 공급사에 직접 연락해 의뢰하는 구조라, 제출 즉시 "매칭"되는
 * 건 아니라는 점을 폼 안내문에 명시한다.
 */
export function RetailerLeadForm() {
  const [restaurantName, setRestaurantName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [region, setRegion] = useState("");
  const [desiredCategory, setDesiredCategory] = useState("");
  const [monthlyVolumeHint, setMonthlyVolumeHint] = useState("");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const result = await submitRetailerMatchRequestAction({
      restaurantName,
      contactName,
      contactPhone,
      region,
      desiredCategory,
      monthlyVolumeHint,
      memo,
    });

    setSubmitting(false);

    if (!result.success) {
      setError(result.error ?? "신청 접수에 실패했습니다.");
      return;
    }

    setDone(true);
  };

  if (done) {
    return (
      <div style={{ textAlign: "center", padding: "20px 0" }}>
        <p style={{ fontSize: "14px", fontWeight: 700, color: "#166534" }}>
          신청이 접수되었습니다.
        </p>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "6px", lineHeight: 1.6 }}>
          담당자가 검토 후 적합한 도매업체를 찾아 직접 연락드립니다.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div>
        <label style={labelStyle} htmlFor="lead-restaurant-name">
          사업장(식당)명 *
        </label>
        <input
          id="lead-restaurant-name"
          type="text"
          required
          value={restaurantName}
          onChange={(event) => setRestaurantName(event.target.value)}
          placeholder="예: 을지로 미트하우스"
          style={fieldStyle}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <div>
          <label style={labelStyle} htmlFor="lead-contact-name">
            담당자명 *
          </label>
          <input
            id="lead-contact-name"
            type="text"
            required
            value={contactName}
            onChange={(event) => setContactName(event.target.value)}
            style={fieldStyle}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="lead-contact-phone">
            연락처 *
          </label>
          <input
            id="lead-contact-phone"
            type="tel"
            required
            value={contactPhone}
            onChange={(event) => setContactPhone(event.target.value)}
            placeholder="010-0000-0000"
            style={fieldStyle}
          />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <div>
          <label style={labelStyle} htmlFor="lead-region">
            지역
          </label>
          <input
            id="lead-region"
            type="text"
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            placeholder="예: 서울 성동구"
            style={fieldStyle}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="lead-category">
            희망 품목
          </label>
          <input
            id="lead-category"
            type="text"
            value={desiredCategory}
            onChange={(event) => setDesiredCategory(event.target.value)}
            placeholder="예: 한우, 돼지고기"
            style={fieldStyle}
          />
        </div>
      </div>

      <div>
        <label style={labelStyle} htmlFor="lead-volume">
          예상 월 물량 (선택)
        </label>
        <input
          id="lead-volume"
          type="text"
          value={monthlyVolumeHint}
          onChange={(event) => setMonthlyVolumeHint(event.target.value)}
          placeholder="예: 월 200kg 내외"
          style={fieldStyle}
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="lead-memo">
          기타 요청사항 (선택)
        </label>
        <textarea
          id="lead-memo"
          rows={2}
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
          style={{ ...fieldStyle, resize: "vertical" }}
        />
      </div>

      {error && (
        <p style={{ fontSize: "12px", color: "#b91c1c" }}>{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting}
        style={{
          marginTop: "4px",
          padding: "12px",
          fontSize: "14px",
          fontWeight: 700,
          color: "#ffffff",
          backgroundColor: submitting ? "#94a3b8" : "#0f172a",
          border: "none",
          borderRadius: "8px",
          cursor: submitting ? "wait" : "pointer",
        }}
      >
        {submitting ? "접수 중..." : "입점 희망 신청하기"}
      </button>
    </form>
  );
}
