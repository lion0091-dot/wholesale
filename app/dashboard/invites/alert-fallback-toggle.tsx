"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveAlimtalkFallbackAction } from "@/app/actions/alimtalk-settings";
import { isAlertGap, type PushDevice } from "@/lib/notifications/push-devices";

/**
 * 공급사용 주문 알림 4종(신규 주문·주문 수정·취소 요청·여신 초과 거절)의 알림톡 폴백 켜기/끄기(마이그레이션 225).
 * 웹푸시가 먼저 가고, 켠 브라우저가 아무도 못 받았을 때만 알림톡이 간다. 끄면 그 경우 알림톡 없이 지나간다.
 */
export function AlertFallbackToggle({ initialEnabled, devices }: { initialEnabled: boolean; devices: PushDevice[] | null }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const change = (next: boolean) => {
    setError(null);

    startTransition(async () => {
      const result = await saveAlimtalkFallbackAction(next);

      if (!result.success) {
        setError(result.error ?? "저장하지 못했습니다.");
        return;
      }

      setEnabled(next);
      router.refresh();
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.7, margin: 0 }}>
        새 주문·주문 수정·취소 요청·여신 한도 초과는 <strong>홈 화면 앱(브라우저) 알림</strong>이 먼저 갑니다. 알림을 켠 기기가 하나도 받지 못했을 때만
        알림톡이 대신 가는지 정합니다.
      </p>
      <label style={{ fontSize: "13px", display: "flex", gap: "8px", alignItems: "flex-start", color: "#0f172a" }}>
        <input type="radio" name="alert-fallback" checked={enabled} disabled={pending} onChange={() => change(true)} />
        <span>
          <strong>알림톡도 안전망으로 씁니다</strong> — 푸시를 아무도 못 받으면 알림톡으로 보냅니다. 주문을 놓칠 가능성이 가장 낮습니다.
        </span>
      </label>
      <label style={{ fontSize: "13px", display: "flex", gap: "8px", alignItems: "flex-start", color: "#0f172a" }}>
        <input type="radio" name="alert-fallback" checked={!enabled} disabled={pending} onChange={() => change(false)} />
        <span>
          <strong>앱 알림만 씁니다</strong> — 푸시를 못 받은 주문은 알림톡 없이 지나갑니다. 화면 맨 위 빨간 줄과 종 배지로만 확인하게 됩니다.
        </span>
      </label>
      {isAlertGap(enabled, devices) ? (
        <p role="alert" style={{ margin: 0, fontSize: "12px", fontWeight: 700, color: "#991b1b", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "8px 10px", lineHeight: 1.6 }}>
          지금 알림을 켠 기기가 하나도 없고 알림톡도 꺼져 있어서 새 주문 알림이 어디로도 가지 않습니다. 직원이 쓰는 폰·PC에서 [알림 켜기]를 누르거나 위에서 알림톡 안전망을 다시 켜세요.
        </p>
      ) : (
        !enabled && (
          <p role="note" style={{ margin: 0, fontSize: "12px", color: "#92400e", backgroundColor: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", padding: "8px 10px", lineHeight: 1.6 }}>
            알림을 켠 기기가 모두 꺼지면 새 주문 알림이 오지 않습니다. 아래 &quot;알림을 켠 기기&quot;에서 켜진 기기가 있는지 확인하세요.
          </p>
        )
      )}
      {devices !== null && (
        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "10px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>알림을 켠 기기 {devices.length}대</div>
          {devices.length === 0 ? (
            <p style={{ margin: 0, fontSize: "12px", color: "#64748b", lineHeight: 1.6 }}>
              아직 알림을 켠 기기가 없습니다. 직원이 쓰는 폰·PC에서 로그인한 뒤 화면 맨 위의 [알림 켜기]를 누르면 여기에 나타납니다.
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "4px" }}>
              {devices.map((device) => (
                <li key={device.id} style={{ fontSize: "12px", color: "#334155", display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <strong style={{ minWidth: "72px" }}>{device.userName}</strong>
                  <span>{device.label}</span>
                  <span style={{ color: "#64748b" }}>
                    {device.lastUsedAt ? `마지막 알림 ${new Date(device.lastUsedAt).toLocaleDateString("ko-KR")}` : `켠 날 ${new Date(device.createdAt).toLocaleDateString("ko-KR")}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: "12px", color: "#b91c1c" }}>
          {error}
        </p>
      )}
    </div>
  );
}
