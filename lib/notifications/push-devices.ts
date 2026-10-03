import type { SupabaseClient } from "@supabase/supabase-js";

/** list_push_devices RPC(마이그레이션 226) 한 줄 — 알림을 켠 기기 하나. 푸시 주소·키는 받지 않는다. */
export interface PushDevice {
  id: string;
  userName: string;
  /** user_agent에서 뽑은 사람이 읽는 이름(예: "아이폰 · 사파리") */
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** 브라우저가 보낸 user_agent를 "기기 · 브라우저"로 줄인다. 모르면 "알 수 없는 기기". */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";

  if (!ua) return "알 수 없는 기기";

  const device = /iPhone/i.test(ua)
    ? "아이폰"
    : /iPad/i.test(ua)
      ? "아이패드"
      : /Android/i.test(ua)
        ? "안드로이드"
        : /Windows/i.test(ua)
          ? "윈도우 PC"
          : /Macintosh|Mac OS X/i.test(ua)
            ? "맥"
            : /Linux/i.test(ua)
              ? "리눅스"
              : "알 수 없는 기기";
  // 순서가 중요하다: 엣지·삼성 브라우저·파이어폭스는 UA에 Chrome/Safari도 같이 들어 있다.
  const browser = /Edg\//i.test(ua)
    ? "엣지"
    : /SamsungBrowser/i.test(ua)
      ? "삼성 인터넷"
      : /Firefox|FxiOS/i.test(ua)
        ? "파이어폭스"
        : /Chrome|CriOS/i.test(ua)
          ? "크롬"
          : /Safari/i.test(ua)
            ? "사파리"
            : null;

  return browser ? `${device} · ${browser}` : device;
}

/** 알림을 켠 기기 목록. 대표·매니저가 아니면 DB가 거부하므로 null. */
export async function fetchPushDevices(supabase: SupabaseClient): Promise<PushDevice[] | null> {
  const { data, error } = await supabase.rpc("list_push_devices");

  if (error || !Array.isArray(data)) return null;

  return (data as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.device_id),
    userName: String(row.user_name ?? ""),
    label: describeDevice((row.user_agent as string | null) ?? null),
    createdAt: String(row.created_at),
    lastUsedAt: (row.last_used_at as string | null) ?? null,
  }));
}

/**
 * 알림톡 폴백이 꺼져 있고 알림을 켠 기기도 없으면 새 주문 알림이 어디로도 가지 않는다 — 경고가 필요한 상태.
 * `devices`가 null(못 읽음)이면 모르는 것이므로 경고하지 않는다.
 */
export function isAlertGap(fallbackEnabled: boolean, devices: PushDevice[] | null): boolean {
  return !fallbackEnabled && devices !== null && devices.length === 0;
}
