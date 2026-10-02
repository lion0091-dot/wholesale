import type { SupabaseClient } from "@supabase/supabase-js";

/** dispose_box RPC(마이그레이션 216)의 사유 코드. 서버 CHECK와 같은 목록. */
export const DISPOSAL_REASONS = [
  { code: "EXPIRED", label: "소비기한 경과" },
  { code: "DAMAGE", label: "파손" },
  { code: "SPOILED", label: "변질" },
  { code: "OTHER", label: "기타(메모 필수)" },
] as const;

export type DisposalReasonCode = (typeof DISPOSAL_REASONS)[number]["code"];

export function disposalReasonLabel(code: string): string {
  return DISPOSAL_REASONS.find((reason) => reason.code === code)?.label.replace("(메모 필수)", "") ?? code;
}

export interface DisposalHistoryRow {
  id: string;
  traceNo: string;
  productName: string | null;
  reasonCode: string;
  note: string | null;
  weight: number;
  afterRemaining: number;
  unitPrice: number | null;
  lossAmount: number | null;
  disposedByName: string;
  createdAt: string;
}

export interface DisposalPreview {
  /** 폐기 후 남는 양. 계산할 수 없으면 null */
  after: number | null;
  /** 손실 금액(원). 매입단가를 모르면 null */
  lossAmount: number | null;
  /** 이 입력으로는 폐기할 수 없는 이유(화면에 보여주고 버튼을 막는다). 없으면 null */
  error: string | null;
}

/**
 * 폐기 미리보기 — 서버(dispose_box)와 같은 규칙으로 "버리면 얼마나 남고 손실이 얼마인가"를 계산한다. 아무것도 바꾸지 않는다.
 * 서버가 최종 판단하므로 화면 안내용이다.
 */
export function previewDisposal(
  remaining: number,
  unitPrice: number | null,
  weight: number | null,
  reasonCode: DisposalReasonCode,
  note: string
): DisposalPreview {
  if (weight === null || !Number.isFinite(weight) || weight <= 0) {
    return { after: null, lossAmount: null, error: "버릴 중량을 0보다 크게 입력해 주세요." };
  }

  if (Math.abs(weight * 1000 - Math.round(weight * 1000)) > 1e-6) {
    return { after: null, lossAmount: null, error: "중량은 소수 셋째 자리(g)까지만 입력할 수 있어요." };
  }

  if (weight > remaining + 1e-9) {
    return { after: null, lossAmount: null, error: "남은 양보다 많이는 버릴 수 없어요." };
  }

  if (reasonCode === "OTHER" && note.trim().length < 2) {
    return { after: null, lossAmount: null, error: "기타 사유는 메모를 2자 이상 적어 주세요." };
  }

  return {
    after: Math.round((remaining - weight) * 1000) / 1000,
    lossAmount: unitPrice === null ? null : Math.round(weight * unitPrice),
    error: null,
  };
}

/** list_box_disposals RPC. 대표가 아니면 DB가 거부하므로 null — 화면은 "대표 아님"으로 보고 폐기 버튼을 숨긴다. */
export async function fetchBoxDisposals(supabase: SupabaseClient, limit = 10): Promise<DisposalHistoryRow[] | null> {
  const { data, error } = await supabase.rpc("list_box_disposals", { p_limit: limit });

  if (error) {
    return null;
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    traceNo: String(row.trace_no ?? ""),
    productName: (row.product_name as string | null) ?? null,
    reasonCode: String(row.reason_code ?? ""),
    note: (row.note as string | null) ?? null,
    weight: Number(row.weight),
    afterRemaining: Number(row.after_remaining),
    unitPrice: row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
    lossAmount: row.loss_amount === null || row.loss_amount === undefined ? null : Number(row.loss_amount),
    disposedByName: String(row.disposed_by_name ?? ""),
    createdAt: String(row.created_at),
  }));
}
