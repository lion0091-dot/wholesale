/**
 * 웹푸시 발송 — 공급사 직원들이 "알림 받기"를 켠 브라우저(push_subscriptions, 마이그 189)로 보낸다.
 *
 * 설정: VAPID 키 쌍(WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY)과 연락처(WEB_PUSH_CONTACT, mailto: 또는 https:).
 * 공개키는 NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY로 브라우저에도 준다(구독할 때 필요).
 * 키가 없으면 "미설정"으로 조용히 넘어가고 호출부는 알림톡으로 간다 — 그래서 키를 안 넣은 배포에서도 아무것도 깨지지 않는다.
 *
 * 전달 보장은 없다(브라우저 회사 서버가 최선을 다할 뿐). 죽은 구독(404·410)은 그 자리에서 지운다.
 * 서버 전용 모듈 — service_role로 읽고 쓴다(세션은 자기 구독만 볼 수 있다).
 */

import webPush, { WebPushError, type PushSubscription } from "web-push";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import type { PushMessage } from "@/lib/notifications/push-messages";

export interface PushSendResult {
  /** 켜 둔 브라우저 수(발송 대상). 0이면 호출부가 알림톡으로 대신 보낸다. */
  subscribers: number;
  /** 브라우저 회사 서버가 접수한 수(수신 보장 아님) */
  accepted: number;
  /** 죽어서 지운 구독 수 */
  pruned: number;
}

const NOT_SENT: PushSendResult = { subscribers: 0, accepted: 0, pruned: 0 };

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function vapid(): { publicKey: string; privateKey: string; contact: string } | null {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY ?? process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const contact = process.env.WEB_PUSH_CONTACT;

  if (!publicKey || !privateKey || !contact) return null;

  return { publicKey, privateKey, contact };
}

export function isWebPushConfigured(): boolean {
  return vapid() !== null;
}

/** 이 업체에 알림 받기를 켠 브라우저가 하나라도 있는가 — 알림톡을 생략할지 정하는 기준. */
export async function hasPushSubscribers(wholesalerId: string): Promise<boolean> {
  if (!isWebPushConfigured()) return false;

  const supabase = createServiceRoleClient();

  if (!supabase) return false;

  const { count } = await supabase
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("wholesaler_id", wholesalerId);

  return (count ?? 0) > 0;
}

/**
 * 업체의 모든 구독에 같은 알림을 보낸다. 실패해도 던지지 않는다(알림은 부가 기능 — 주문 처리를 막으면 안 된다).
 */
export async function sendWholesalerPush(wholesalerId: string, message: PushMessage): Promise<PushSendResult> {
  const keys = vapid();
  const supabase = createServiceRoleClient();

  if (!keys || !supabase) return NOT_SENT;

  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("wholesaler_id", wholesalerId);

  if (error || !data || data.length === 0) {
    if (error) console.error("[WebPush] 구독 조회 실패:", error.message);

    return NOT_SENT;
  }

  const rows = data as SubscriptionRow[];
  const body = JSON.stringify(message);
  const options = {
    vapidDetails: { subject: keys.contact, publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 60 * 60 * 6, // 6시간 안에 폰이 안 켜지면 버린다 — 반나절 지난 "새 주문"은 의미가 없다.
    urgency: "high" as const,
  };

  const dead: string[] = [];
  const alive: string[] = [];

  await Promise.all(
    rows.map(async (row) => {
      const subscription: PushSubscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };

      try {
        await webPush.sendNotification(subscription, body, options);
        alive.push(row.id);
      } catch (cause) {
        // 404·410 = 브라우저가 구독을 버렸다(알림 끔·앱 삭제·브라우저 데이터 삭제). 지워서 다음부터 안 보낸다.
        if (cause instanceof WebPushError && (cause.statusCode === 404 || cause.statusCode === 410)) {
          dead.push(row.id);
        } else {
          console.error("[WebPush] 발송 실패:", cause instanceof Error ? cause.message : cause);
        }
      }
    })
  );

  const now = new Date().toISOString();

  if (alive.length > 0) await supabase.from("push_subscriptions").update({ last_used_at: now }).in("id", alive);
  if (dead.length > 0) await supabase.from("push_subscriptions").delete().in("id", dead);

  return { subscribers: rows.length, accepted: alive.length, pruned: dead.length };
}
