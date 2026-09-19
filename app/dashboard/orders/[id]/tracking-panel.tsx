"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KOREAN_COURIERS, courierLabel, type TrackingResult } from "@/lib/verification/sweettracker";
import { updateOrderTrackingAction, fetchOrderTrackingStatusAction } from "../actions";

interface TrackingPanelProps {
  orderId: string;
  courierCode: string | null;
  trackingNumber: string | null;
  /** 스위트트래커 API 키 미설정 시 조회 버튼을 잠근다 (입력/저장은 계속 가능). */
  sweetTrackerConfigured: boolean;
  /** 데모(샘플) 발주서는 저장할 수 없다. */
  readOnly?: boolean;
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: "13px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
};

export function TrackingPanel({
  orderId,
  courierCode,
  trackingNumber,
  sweetTrackerConfigured,
  readOnly = false,
}: TrackingPanelProps) {
  const router = useRouter();
  const [courier, setCourier] = useState(courierCode ?? KOREAN_COURIERS[0].code);
  const [number, setNumber] = useState(trackingNumber ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const [open, setOpen] = useState(false);
  const [lookupPending, setLookupPending] = useState(false);
  const [lookupResult, setLookupResult] = useState<TrackingResult | null>(null);

  const hasSaved = Boolean(courierCode && trackingNumber);

  const handleSave = async () => {
    if (readOnly) {
      setMessage({ type: "error", text: "샘플 발주서는 저장할 수 없습니다. 로그인 후 실제 발주서에서 이용해주세요." });
      return;
    }

    setSaving(true);
    setMessage(null);

    const result = await updateOrderTrackingAction(orderId, courier, number);

    setSaving(false);

    if (!result.success) {
      setMessage({ type: "error", text: result.error ?? "저장에 실패했습니다." });
      return;
    }

    const shippedText =
      result.data?.status === "shipping"
        ? " 발주 상태가 '배송중'으로 자동 전환됩니다."
        : "";
    const verificationText =
      result.data?.verification === "skipped_not_configured"
        ? " (배송 조회 API 키가 설정되지 않아 실제 존재하는 운송장인지는 확인하지 않았습니다.)"
        : " (스위트트래커로 조회 가능한 운송장임을 확인했습니다.)";

    setMessage({
      type: "success",
      text: `운송장 정보가 저장되었습니다.${shippedText}${verificationText}`,
    });
    router.refresh();
  };

  const handleToggleLookup = async () => {
    const nextOpen = !open;
    setOpen(nextOpen);

    if (nextOpen && !lookupResult) {
      setLookupPending(true);
      const result = await fetchOrderTrackingStatusAction(orderId);
      setLookupPending(false);

      if (result.success && result.data) {
        setLookupResult(result.data);
      } else {
        setLookupResult({ status: "error", message: result.error ?? "조회에 실패했습니다." });
      }
    }
  };

  return (
    <section
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        padding: "16px",
      }}
    >
      <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
        배송 조회
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
        <select value={courier} onChange={(e) => setCourier(e.target.value)} style={inputStyle}>
          {KOREAN_COURIERS.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="운송장번호"
          style={{ ...inputStyle, flex: "1 1 160px", minWidth: 0 }}
        />
        <button
          type="button"
          disabled={saving || !number.trim()}
          onClick={() => void handleSave()}
          style={{
            fontSize: "13px",
            fontWeight: 700,
            color: "#ffffff",
            backgroundColor: saving ? "#94a3b8" : "#0f172a",
            border: "none",
            borderRadius: "6px",
            padding: "8px 16px",
            cursor: saving ? "not-allowed" : "pointer",
          }}
        >
          {saving ? "저장 중..." : "저장"}
        </button>
      </div>

      {message && (
        <p
          style={{
            fontSize: "12px",
            color: message.type === "error" ? "#b91c1c" : "#166534",
            marginBottom: "8px",
          }}
        >
          {message.text}
        </p>
      )}

      {hasSaved &&
        (sweetTrackerConfigured ? (
          <div>
            <button
              type="button"
              onClick={() => void handleToggleLookup()}
              style={{
                fontSize: "12px",
                fontWeight: 700,
                color: "#2563eb",
                border: "1px solid #bfdbfe",
                backgroundColor: "#eff6ff",
                borderRadius: "6px",
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              📦 {courierLabel(courierCode)} {trackingNumber} 배송 조회 {open ? "▲" : "▼"}
            </button>

            {open && (
              <div style={{ marginTop: "10px", fontSize: "12px" }}>
                {lookupPending ? (
                  <p style={{ color: "#64748b" }}>조회 중...</p>
                ) : lookupResult ? (
                  <>
                    <p
                      style={{
                        fontWeight: 700,
                        color: lookupResult.status === "ok" ? "#166534" : "#b91c1c",
                        marginBottom: "6px",
                      }}
                    >
                      {lookupResult.message}
                    </p>
                    {lookupResult.events && lookupResult.events.length > 0 && (
                      <ul style={{ display: "flex", flexDirection: "column", gap: "4px", color: "#334155" }}>
                        {lookupResult.events.map((event, index) => (
                          <li key={index}>
                            {event.time} · {event.location} · {event.status}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <p style={{ fontSize: "11px", color: "#94a3b8" }}>
            배송 조회는 스위트트래커 API 키(SWEETTRACKER_API_KEY)를 서버 환경변수에
            등록해야 사용할 수 있습니다. (플랫폼 운영자 설정 필요)
          </p>
        ))}
    </section>
  );
}
