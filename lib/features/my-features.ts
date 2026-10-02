import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * 지금 로그인한 사람이 쓸 수 있는 기능과 업체별 세부 설정(마이그레이션 210의 my_usable_features).
 * "이 업체에서 켜져 있고, 대표이거나 대표가 허용한 사람"인 기능만 들어 있다.
 * 같은 요청 안에서는 한 번만 부른다(여러 탭·화면이 같이 물어도 DB 왕복은 1번).
 * 조회에 실패하면 빈 목록 — 기능이 안 보일 뿐 화면이 깨지지 않는다. 진짜 막는 건 각 기능의 DB 함수다.
 */
export const getMyUsableFeatures = cache(async (): Promise<Map<string, Record<string, unknown>>> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("my_usable_features");

    if (error || !Array.isArray(data)) return new Map();

    return new Map(
      (data as Array<{ feature_key: string; config: Record<string, unknown> | null }>).map((row) => [
        row.feature_key,
        row.config ?? {},
      ])
    );
  } catch {
    return new Map();
  }
});

/**
 * 이 업체에서 "켜져 있는" 기능(부모 메뉴가 꺼진 자식 제외) — 누가 쓰나(허용 목록)는 보지 않는다(마이그레이션 217).
 * 회계 관리 탭처럼 "켜짐/꺼짐"만 가르고 보는 사람은 기존 역할 규칙이 정하는 기능의 메뉴·탭을 가릴 때 쓴다.
 * 조회에 실패하면 빈 집합 — 탭이 안 보일 뿐 화면이 깨지지 않는다. 진짜 막는 건 각 기능의 DB 함수나 서버 액션이다.
 */
export const getMyEnabledFeatures = cache(async (): Promise<Set<string>> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("current_wholesaler_features");

    if (error || !Array.isArray(data)) return new Set();

    return new Set((data as Array<{ feature_key: string }>).map((row) => row.feature_key));
  } catch {
    return new Set();
  }
});

/** 기능 키 이름 — 오타를 막으려고 한 곳에 모은다. 새 기능은 마이그레이션에서 platform_features에 등록한 키와 같게 추가한다. */
export const FEATURE_KEYS = {
  costManagement: "cost_management",
  accounting: "accounting",
  accountingReceivables: "accounting_receivables",
  accountingPurchases: "accounting_purchases",
  accountingIntegrity: "accounting_integrity",
  accountingStockAdjust: "accounting_stock_adjust",
} as const;

export interface AccountingTab {
  label: string;
  href: string;
}

/**
 * 회계 관리 메뉴의 탭 목록(마이그레이션 217). 순서가 곧 화면 순서이고, 메뉴 자체의 이동 주소는 첫 탭이다.
 * - 미수금 정산·매입 정산: 켜져 있으면 보인다(보는 사람 제한은 각 화면의 기존 규칙 — 매입 정산은 원가 열람 범위).
 * - 원가 관리: 켜져 있고 대표가 허용한 사람만(`usable`).
 * - 재고 조정·손실: 켜져 있고 대표만(`isOwner`) — 손실 금액에 매입 원가가 들어 있다(218).
 * - 장부 불일치: 켜져 있고 대표만(`isOwner`).
 * 메뉴 자체(accounting)가 꺼져 있으면 enabled에 자식이 들어 있지 않으므로 빈 목록이다.
 */
export function buildAccountingTabs(
  enabled: { has(key: string): boolean },
  usable: { has(key: string): boolean },
  isOwner: boolean
): AccountingTab[] {
  return [
    ...(enabled.has(FEATURE_KEYS.accountingReceivables) ? [{ label: "미수금 정산", href: "/dashboard/receivables" }] : []),
    ...(enabled.has(FEATURE_KEYS.accountingPurchases) ? [{ label: "매입 정산", href: "/dashboard/purchases" }] : []),
    ...(usable.has(FEATURE_KEYS.costManagement) ? [{ label: "원가 관리", href: "/dashboard/stock-valuation" }] : []),
    ...(isOwner && enabled.has(FEATURE_KEYS.accountingStockAdjust) ? [{ label: "재고 조정·손실", href: "/dashboard/stock-adjustments" }] : []),
    ...(isOwner && enabled.has(FEATURE_KEYS.accountingIntegrity) ? [{ label: "장부 불일치", href: "/dashboard/stock-integrity" }] : []),
  ];
}
