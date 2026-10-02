import type { SupabaseClient } from "@supabase/supabase-js";

/** 월별·거래처별 줄이 같이 가지는 건수·금액 칸(마이그레이션 222). */
export interface TaxInvoiceCounts {
  /** 발행 완료한 최초 발행 건수 */
  issuedCount: number;
  /** 그 금액 합계(주문 총액). 정정 발행은 같은 주문을 다시 신고하는 것이라 합치지 않는다. */
  issuedAmount: number;
  /** 발행 완료한 정정 발행 건수 */
  correctedCount: number;
  /** 결과를 모르는(진행 중) 발행 건수 — 팝빌에서 확인해 정리하기 전까지 재발행이 막힌다 */
  pendingCount: number;
  failedCount: number;
}

export interface TaxInvoiceMonthRow extends TaxInvoiceCounts {
  /** 그 달 1일(YYYY-MM-DD, 한국 시간 기준) */
  monthStart: string;
}

export interface TaxInvoiceRetailerRow extends TaxInvoiceCounts {
  retailerId: string;
  retailerName: string;
}

export function summarizeTaxInvoices(rows: TaxInvoiceCounts[]): TaxInvoiceCounts {
  const sum = (pick: (row: TaxInvoiceCounts) => number) => rows.reduce((total, row) => total + pick(row), 0);

  return {
    issuedCount: sum((row) => row.issuedCount),
    issuedAmount: sum((row) => row.issuedAmount),
    correctedCount: sum((row) => row.correctedCount),
    pendingCount: sum((row) => row.pendingCount),
    failedCount: sum((row) => row.failedCount),
  };
}

function toCounts(row: Record<string, unknown>): TaxInvoiceCounts {
  return {
    issuedCount: Number(row.issued_count),
    issuedAmount: Number(row.issued_amount),
    correctedCount: Number(row.corrected_count),
    pendingCount: Number(row.pending_count),
    failedCount: Number(row.failed_count),
  };
}

export type TaxInvoiceTodoKind = "pending" | "failed" | "missing";

/** get_tax_invoice_todo 한 줄(마이그레이션 223) — 챙겨야 할 주문 하나. */
export interface TaxInvoiceTodoRow {
  kind: TaxInvoiceTodoKind;
  orderId: string;
  orderNumber: string;
  retailerName: string;
  totalAmount: number;
  /** pending·failed = 이력을 만든 시각, missing = 출고 확정 시각 */
  happenedAt: string;
  errorMessage: string | null;
}

export interface FetchTaxInvoiceSummaryResult {
  months: TaxInvoiceMonthRow[];
  retailers: TaxInvoiceRetailerRow[];
  todo: TaxInvoiceTodoRow[];
  /** 상한(300건) 적용 전 챙길 주문 전체 건수 */
  todoTotal: number;
}

export const TODO_KIND_LABEL: Record<TaxInvoiceTodoKind, string> = {
  pending: "진행 중(결과 모름)",
  failed: "발행 실패",
  missing: "계산서 없음",
};

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\n\r]/;

/** CSV 한 칸 — 쉼표·따옴표·줄바꿈을 감싸고, 엑셀이 수식으로 읽을 수 있는 첫 글자(= + - @)는 앞에 작은따옴표를 붙인다. */
export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;

  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export type TaxInvoiceCsvKind = "months" | "retailers" | "todo";

/** 집계 한 표를 CSV 문자열로(엑셀에서 한글이 깨지지 않게 맨 앞에 BOM). */
export function buildTaxInvoiceCsv(kind: TaxInvoiceCsvKind, result: FetchTaxInvoiceSummaryResult): string {
  const countHeader = ["발행 건수", "발행 금액", "정정 발행", "진행 중", "실패"];
  const counts = (row: TaxInvoiceCounts) => [row.issuedCount, row.issuedAmount, row.correctedCount, row.pendingCount, row.failedCount];
  let table: Array<Array<string | number>>;

  if (kind === "months") {
    table = [["월", ...countHeader], ...result.months.map((row) => [row.monthStart.slice(0, 7), ...counts(row)])];
  } else if (kind === "retailers") {
    table = [["거래처", ...countHeader], ...result.retailers.map((row) => [row.retailerName, ...counts(row)])];
  } else {
    table = [
      ["구분", "주문번호", "거래처", "주문 금액", "일시", "실패 사유"],
      ...result.todo.map((row) => [
        TODO_KIND_LABEL[row.kind],
        row.orderNumber,
        row.retailerName,
        row.totalAmount,
        row.happenedAt,
        row.errorMessage ?? "",
      ]),
    ];
  }

  return `﻿${table.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/**
 * 계산서 집계 탭 데이터. 대표·매니저가 아니거나 탭이 꺼져 있거나 기간이 잘못되면 DB가 거부하므로 null — 화면은 안내를 보여준다.
 * 날짜는 YYYY-MM-DD(한국 시간 기준, 끝 날짜 포함).
 */
export async function fetchTaxInvoiceSummary(
  supabase: SupabaseClient,
  range: { from: string | null; to: string | null }
): Promise<FetchTaxInvoiceSummaryResult | null> {
  const args = { p_from: range.from, p_to: range.to };
  const [month, retailer, todo] = await Promise.all([
    supabase.rpc("get_tax_invoice_by_month", args),
    supabase.rpc("get_tax_invoice_by_retailer", args),
    supabase.rpc("get_tax_invoice_todo", args),
  ]);

  if (month.error || retailer.error || todo.error) {
    return null;
  }

  const todoRows = (todo.data ?? []) as Array<Record<string, unknown>>;

  return {
    todo: todoRows.map((row) => ({
      kind: row.kind as TaxInvoiceTodoKind,
      orderId: String(row.order_id),
      orderNumber: String(row.order_number ?? ""),
      retailerName: String(row.retailer_name ?? ""),
      totalAmount: Number(row.total_amount),
      happenedAt: String(row.happened_at),
      errorMessage: row.error_message === null || row.error_message === undefined ? null : String(row.error_message),
    })),
    todoTotal: todoRows.length > 0 ? Number(todoRows[0].total_count) : 0,
    months: ((month.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      monthStart: String(row.month_start),
      ...toCounts(row),
    })),
    retailers: ((retailer.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      retailerId: String(row.retailer_id),
      retailerName: String(row.retailer_name ?? ""),
      ...toCounts(row),
    })),
  };
}
