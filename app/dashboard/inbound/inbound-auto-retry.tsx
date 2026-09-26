"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { retryUnresolvedScansAction } from "./actions";

/** 화면이 열려 있는 동안 이력조회 실패 박스를 몇 분마다 시스템이 다시 조회한다(같은 박스는 서버가 30분에 한 번만). 눈에 보이는 것은 없다. */
const RETRY_EVERY_MS = 5 * 60_000;

export function InboundAutoRetry() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (document.visibilityState === "hidden") return;

      const result = await retryUnresolvedScansAction();

      // 조회가 되어 재고에 들어간 박스가 있으면 화면을 새로 그린다.
      if (!cancelled && result.success && (result.data?.resolved ?? 0) > 0) router.refresh();
    };

    void run();
    const timer = window.setInterval(() => void run(), RETRY_EVERY_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [router]);

  return null;
}
