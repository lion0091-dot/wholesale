/*
 * 웹푸시 서비스워커 — 하는 일은 두 가지뿐이다.
 * 1) 서버가 보낸 푸시를 받아 알림으로 띄운다.
 * 2) 알림을 누르면 그 화면(기본: 고객 주문)을 연다 — 이미 열려 있는 탭이 있으면 그 탭으로 간다.
 * 오프라인 캐시는 일부러 안 한다(화면이 옛 상태로 보이는 사고를 피하기 위해).
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "미트 파트너스", body: "", url: "/dashboard/orders", tag: undefined };

  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // 본문이 JSON이 아니면 기본 문구로 띄운다.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      renotify: Boolean(payload.tag),
      icon: "/icon/192",
      badge: "/icon/192",
      data: { url: payload.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = new URL((event.notification.data && event.notification.data.url) || "/dashboard/orders", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const same = windows.find((client) => client.url === url && "focus" in client);

      if (same) return same.focus();

      const any = windows.find((client) => "navigate" in client && "focus" in client);

      if (any) return any.navigate(url).then((client) => (client ? client.focus() : undefined));

      return self.clients.openWindow(url);
    })
  );
});
