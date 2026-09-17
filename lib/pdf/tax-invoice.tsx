/**
 * 계산서(면세) 작성 도우미 — 서버사이드 PDF 렌더러.
 *
 * ⚠️ 국세청에 정식 발행되는 전자계산서가 아니다. 발주 데이터를 계산서 표준 항목에
 * 맞춰 정리해주는 "초안 도우미"일 뿐이며, 실제 발행은 사용자가 이 내용을 보고
 * 홈택스에 직접 입력해야 한다(자동 발행 아님 — ROADMAP §7).
 *
 * 축산물 도소매는 대부분 미가공(단순 절단·냉동·포장 수준) 축산물이라 부가가치세법
 * 시행령 제34조상 면세 대상이다 — 그래서 "세금계산서"가 아니라 "계산서"로 만든다.
 * 가공육(햄·소시지 등) 등 과세 품목을 취급하게 되면 별도 세금계산서(세액 10% 포함)
 * 양식이 추가로 필요하다 — 지금은 면세만 지원한다.
 */

import path from "node:path";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { formatOrderedAt, formatWon } from "@/lib/orders/status";
import type { StatementData, StatementParty } from "@/lib/orders/statement";

const FONT_FAMILY = "NotoSansKR";
let fontRegistered = false;

function registerFontOnce() {
  if (fontRegistered) {
    return;
  }

  const fontDir = path.join(process.cwd(), "assets", "fonts");

  Font.register({
    family: FONT_FAMILY,
    fonts: [
      { src: path.join(fontDir, "NotoSansKR-Regular.ttf"), fontWeight: 400 },
      { src: path.join(fontDir, "NotoSansKR-Bold.ttf"), fontWeight: 700 },
    ],
  });

  Font.registerHyphenationCallback((word) => [word]);

  fontRegistered = true;
}

export interface TaxInvoiceOverrides {
  /** 작성연월일 (YYYY-MM-DD) — 계산서 필요적 기재사항 */
  issueDate: string;
  /** 업태/종목은 DB에 없는 임의 기재사항이라 작성 시점에 직접 입력받는다 */
  supplierBusinessType: string;
  supplierBusinessItem: string;
  buyerBusinessType: string;
  buyerBusinessItem: string;
  /** 비고 */
  note: string;
}

const styles = StyleSheet.create({
  page: {
    fontFamily: FONT_FAMILY,
    fontSize: 9,
    color: "#0f172a",
    padding: 32,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    textAlign: "center",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 9,
    textAlign: "center",
    color: "#64748b",
    marginBottom: 20,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
    fontSize: 9,
    color: "#334155",
  },
  partyRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  partyBox: {
    flex: 1,
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    padding: 10,
  },
  partyLabel: {
    fontSize: 9,
    fontWeight: 700,
    color: "#ffffff",
    backgroundColor: "#0f172a",
    borderRadius: 4,
    paddingVertical: 3,
    paddingHorizontal: 6,
    alignSelf: "flex-start",
    marginBottom: 6,
  },
  partyLine: {
    flexDirection: "row",
    marginBottom: 3,
  },
  partyTerm: {
    width: 56,
    color: "#64748b",
  },
  partyValue: {
    flex: 1,
    color: "#0f172a",
  },
  table: {
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    marginBottom: 12,
  },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: "#f1f5f9",
    borderBottom: "1px solid #e2e8f0",
  },
  tableRow: {
    flexDirection: "row",
    borderBottom: "1px solid #f1f5f9",
  },
  cellNo: { width: 28, padding: 6, textAlign: "center" },
  cellName: { flex: 1, padding: 6 },
  cellPrice: { width: 80, padding: 6, textAlign: "right" },
  cellQty: { width: 56, padding: 6, textAlign: "right" },
  cellAmount: { width: 90, padding: 6, textAlign: "right" },
  headerCell: { fontWeight: 700, color: "#334155" },
  totalRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "baseline",
    gap: 8,
    marginBottom: 20,
  },
  totalLabel: { fontSize: 10, color: "#64748b" },
  totalValue: { fontSize: 14, fontWeight: 700 },
  notesBox: {
    border: "1px solid #fde68a",
    backgroundColor: "#fffbeb",
    borderRadius: 6,
    padding: 8,
    marginBottom: 16,
    color: "#92400e",
    fontSize: 8.5,
  },
  disclaimer: {
    marginTop: "auto",
    borderTop: "1px solid #e2e8f0",
    paddingTop: 8,
    fontSize: 7.5,
    color: "#94a3b8",
    lineHeight: 1.5,
  },
});

function PartyBox({
  label,
  party,
  businessType,
  businessItem,
}: {
  label: string;
  party: StatementParty;
  businessType: string;
  businessItem: string;
}) {
  const rows: Array<[string, string]> = [
    ["등록번호", party.businessNumber ?? "-"],
    ["상호", party.name],
    ["성명", party.representativeName ?? "-"],
    ["주소", party.address ?? "-"],
    ["업태", businessType || "-"],
    ["종목", businessItem || "-"],
  ];

  return (
    <View style={styles.partyBox}>
      <Text style={styles.partyLabel}>{label}</Text>
      {rows.map(([term, value]) => (
        <View key={term} style={styles.partyLine}>
          <Text style={styles.partyTerm}>{term}</Text>
          <Text style={styles.partyValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

function formatIssueDate(value: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function TaxInvoiceDocument({
  data,
  overrides,
}: {
  data: StatementData;
  overrides: TaxInvoiceOverrides;
}) {
  return (
    <Document title={`계산서_${data.orderNumber}`}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>계산서</Text>
        <Text style={styles.subtitle}>(면세) Tax-Exempt Invoice Draft</Text>

        <View style={styles.metaRow}>
          <Text>작성연월일: {formatIssueDate(overrides.issueDate)}</Text>
          <Text>참조 발주번호: {data.orderNumber}</Text>
          <Text>발주일시: {formatOrderedAt(data.orderedAt)}</Text>
        </View>

        <View style={styles.partyRow}>
          <PartyBox
            label="공급자"
            party={data.supplier}
            businessType={overrides.supplierBusinessType}
            businessItem={overrides.supplierBusinessItem}
          />
          <PartyBox
            label="공급받는자"
            party={data.buyer}
            businessType={overrides.buyerBusinessType}
            businessItem={overrides.buyerBusinessItem}
          />
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.cellNo, styles.headerCell]}>No</Text>
            <Text style={[styles.cellName, styles.headerCell]}>품목명</Text>
            <Text style={[styles.cellPrice, styles.headerCell]}>단가</Text>
            <Text style={[styles.cellQty, styles.headerCell]}>수량</Text>
            <Text style={[styles.cellAmount, styles.headerCell]}>공급가액</Text>
          </View>
          {data.items.map((item, index) => (
            <View key={`${item.productName}-${index}`} style={styles.tableRow}>
              <Text style={styles.cellNo}>{index + 1}</Text>
              <Text style={styles.cellName}>{item.productName}</Text>
              <Text style={styles.cellPrice}>{formatWon(item.unitPrice)}</Text>
              <Text style={styles.cellQty}>{item.quantity}</Text>
              <Text style={styles.cellAmount}>{formatWon(item.subtotalAmount)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>공급가액 합계 (면세)</Text>
          <Text style={styles.totalValue}>{formatWon(data.totalAmount)}</Text>
        </View>

        {overrides.note && (
          <View style={styles.partyBox}>
            <Text style={styles.partyLabel}>비고</Text>
            <Text style={styles.partyValue}>{overrides.note}</Text>
          </View>
        )}

        <Text style={styles.disclaimer}>
          본 문서는 발주 데이터를 계산서 표준 항목에 맞춰 정리한 작성 초안이며, 국세청에 정식
          발행된 전자계산서가 아닙니다. 이 내용을 확인한 뒤 홈택스 등에서 직접 발행해야 합니다.
          업태/종목은 자동으로 채워지지 않으니 발행 전 반드시 실제 값으로 확인·수정하세요.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderTaxInvoicePdf(
  data: StatementData,
  overrides: TaxInvoiceOverrides
): Promise<Buffer> {
  registerFontOnce();

  return renderToBuffer(<TaxInvoiceDocument data={data} overrides={overrides} />);
}
