"use client";

import { useState, useTransition, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createPlatformEventAction, cancelPlatformEventAction } from "./actions";

export interface SupplierOption {
  id: string;
  businessName: string;
}

export interface PlatformEventTarget {
  wholesalerId: string;
  businessName: string;
  /** null이면 이벤트 기본 할인율 적용 */
  discountRate: number | null;
}

export interface PlatformEventRow {
  id: string;
  name: string;
  discountRate: number;
  eventType: "common" | "individual";
  startsOn: string;
  endsOn: string;
  durationDays: number;
  status: "active" | "cancelled";
  createdByName: string;
  createdAt: string;
  cancelledByName: string | null;
  cancelledAt: string | null;
  targets: PlatformEventTarget[];
}

interface EventManagerProps {
  suppliers: SupplierOption[];
  initialEvents: PlatformEventRow[];
}

const fieldStyle: CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  fontSize: "13px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 700,
  color: "#334155",
  marginBottom: "5px",
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ko-KR");
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

type LifecycleStatus = "예정" | "진행중" | "종료" | "취소됨";

function resolveLifecycleStatus(event: PlatformEventRow): LifecycleStatus {
  if (event.status === "cancelled") {
    return "취소됨";
  }

  const today = todayDateString();

  if (today < event.startsOn) return "예정";
  if (today > event.endsOn) return "종료";
  return "진행중";
}

const LIFECYCLE_BADGES: Record<LifecycleStatus, { bg: string; color: string }> = {
  예정: { bg: "#e0e7ff", color: "#3730a3" },
  진행중: { bg: "#dcfce7", color: "#166534" },
  종료: { bg: "#f1f5f9", color: "#64748b" },
  취소됨: { bg: "#fee2e2", color: "#991b1b" },
};

export function EventManager({ suppliers, initialEvents }: EventManagerProps) {
  const router = useRouter();
  const [events] = useState(initialEvents);
  const [name, setName] = useState("");
  const [discountRate, setDiscountRate] = useState(10);
  const [eventType, setEventType] = useState<"common" | "individual">("common");
  const [startsOn, setStartsOn] = useState(todayDateString());
  const [durationDays, setDurationDays] = useState(30);
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<string[]>([]);
  const [supplierRateOverrides, setSupplierRateOverrides] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggleSupplier = (id: string) => {
    setSelectedSupplierIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (eventType === "individual" && selectedSupplierIds.length === 0) {
      setError("개별 이벤트는 대상 업체를 하나 이상 선택해주세요.");
      return;
    }

    startTransition(async () => {
      const supplierRates =
        eventType === "individual"
          ? selectedSupplierIds.map((id) => {
              const raw = supplierRateOverrides[id];
              const parsed = raw !== undefined && raw.trim() !== "" ? Number(raw) : null;

              return {
                wholesalerId: id,
                discountRate: parsed !== null && Number.isFinite(parsed) ? parsed : null,
              };
            })
          : undefined;

      const result = await createPlatformEventAction({
        name,
        discountRate,
        eventType,
        startsOn,
        durationDays,
        supplierRates,
      });

      if (!result.success) {
        setError(result.error ?? "이벤트 생성에 실패했습니다.");
        return;
      }

      setName("");
      setDiscountRate(10);
      setEventType("common");
      setStartsOn(todayDateString());
      setDurationDays(30);
      setSelectedSupplierIds([]);
      setSupplierRateOverrides({});
      router.refresh();
    });
  };

  const handleCancel = (eventId: string) => {
    if (!confirm("이 이벤트를 취소하시겠습니까? 취소 후에는 되돌릴 수 없습니다.")) {
      return;
    }

    startTransition(async () => {
      const result = await cancelPlatformEventAction(eventId);

      if (!result.success) {
        alert(result.error ?? "이벤트 취소에 실패했습니다.");
        return;
      }

      router.refresh();
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <form
        onSubmit={handleSubmit}
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}
      >
        <h2 style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>새 이벤트 만들기</h2>

        <div>
          <label style={labelStyle}>이벤트 이름</label>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="예: 미트파트너스 오픈 1주년 기념"
            required
            disabled={pending}
            style={fieldStyle}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px" }}>
          <div>
            <label style={labelStyle}>기본 할인율 (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={discountRate}
              onChange={(event) => setDiscountRate(Number(event.target.value))}
              required
              disabled={pending}
              style={fieldStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>시작일</label>
            <input
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
              required
              disabled={pending}
              style={fieldStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>기간(일)</label>
            <input
              type="number"
              min={1}
              value={durationDays}
              onChange={(event) => setDurationDays(Number(event.target.value))}
              required
              disabled={pending}
              style={fieldStyle}
            />
          </div>
        </div>

        <p style={{ fontSize: "11px", color: "#94a3b8" }}>
          종료일: {formatDate(addDaysToDateString(startsOn, durationDays))} (자동 계산, 시작일 + 기간)
        </p>

        <div>
          <label style={labelStyle}>대상</label>
          <div style={{ display: "flex", gap: "8px" }}>
            {(["common", "individual"] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setEventType(type)}
                disabled={pending}
                style={{
                  flex: 1,
                  padding: "9px",
                  borderRadius: "8px",
                  border: `1px solid ${eventType === type ? "#0f172a" : "#e2e8f0"}`,
                  backgroundColor: eventType === type ? "#0f172a" : "#ffffff",
                  color: eventType === type ? "#ffffff" : "#334155",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: pending ? "wait" : "pointer",
                }}
              >
                {type === "common" ? "전체 공급사 공통" : "특정 업체 개별"}
              </button>
            ))}
          </div>
        </div>

        {eventType === "individual" && (
          <div
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              maxHeight: "280px",
              overflowY: "auto",
            }}
          >
            {suppliers.length === 0 && (
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>등록된 공급사가 없습니다.</span>
            )}
            {suppliers.map((supplier) => {
              const checked = selectedSupplierIds.includes(supplier.id);

              return (
                <div key={supplier.id} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      flex: 1,
                      fontSize: "13px",
                      color: "#334155",
                      cursor: "pointer",
                    }}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleSupplier(supplier.id)} disabled={pending} />
                    {supplier.businessName}
                  </label>
                  {checked && (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      placeholder={`기본 ${discountRate}%`}
                      value={supplierRateOverrides[supplier.id] ?? ""}
                      onChange={(event) =>
                        setSupplierRateOverrides((prev) => ({ ...prev, [supplier.id]: event.target.value }))
                      }
                      disabled={pending}
                      style={{ ...fieldStyle, width: "90px" }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {error && (
          <p role="alert" style={{ fontSize: "12px", color: "#b91c1c" }}>
            {error}
          </p>
        )}

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
          {pending ? "처리 중..." : "이벤트 만들기"}
        </button>

        <p style={{ fontSize: "11px", color: "#94a3b8", lineHeight: 1.6 }}>
          생성 후에는 이름·할인율·기간·대상을 수정할 수 없습니다 — 취소만 가능합니다.
        </p>
      </form>

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <h2 style={{ fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>전체 이벤트 이력</h2>

        {events.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8" }}>아직 만든 이벤트가 없습니다.</p>
        ) : (
          events.map((event) => {
            const lifecycle = resolveLifecycleStatus(event);
            const badge = LIFECYCLE_BADGES[lifecycle];

            return (
              <div
                key={event.id}
                style={{
                  backgroundColor: "#ffffff",
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "16px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                      <h3 style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>{event.name}</h3>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: "6px",
                          backgroundColor: badge.bg,
                          color: badge.color,
                        }}
                      >
                        {lifecycle}
                      </span>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: "6px",
                          backgroundColor: "#f1f5f9",
                          color: "#334155",
                        }}
                      >
                        {event.eventType === "common" ? "공통" : `개별 · ${event.targets.length}곳`}
                      </span>
                    </div>
                    <p style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>
                      할인율 {event.discountRate}% · {formatDate(event.startsOn)} ~ {formatDate(event.endsOn)} (
                      {event.durationDays}일)
                    </p>
                    <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>
                      생성: {event.createdByName} · {formatDateTime(event.createdAt)}
                      {event.cancelledAt && (
                        <>
                          {" "}
                          · 취소: {event.cancelledByName} · {formatDateTime(event.cancelledAt)}
                        </>
                      )}
                    </p>

                    {event.eventType === "individual" && event.targets.length > 0 && (
                      <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "3px" }}>
                        {event.targets.map((target) => (
                          <span key={target.wholesalerId} style={{ fontSize: "11px", color: "#475569" }}>
                            · {target.businessName} ({target.discountRate ?? event.discountRate}%)
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {event.status === "active" && lifecycle !== "종료" && (
                    <button
                      type="button"
                      onClick={() => handleCancel(event.id)}
                      disabled={pending}
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "#b91c1c",
                        backgroundColor: "#fef2f2",
                        border: "1px solid #fecaca",
                        borderRadius: "6px",
                        padding: "5px 10px",
                        cursor: pending ? "wait" : "pointer",
                      }}
                    >
                      이벤트 취소
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function addDaysToDateString(dateStr: string, days: number): string {
  const base = new Date(`${dateStr}T00:00:00Z`);

  if (Number.isNaN(base.getTime()) || !Number.isFinite(days)) {
    return dateStr;
  }

  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
