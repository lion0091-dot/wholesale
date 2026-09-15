/**
 * 거래명세서(Transaction Statement) 서버사이드 PDF 렌더러.
 *
 * ⚠️ 이 문서는 세금계산서를 대체하지 않는다 — 부가가치세법상 법정 증빙서류가
 * 아닌, 발주 내역을 정리한 상관례상 참고 문서다(lib/orders/statement.ts 참고).
 * PDF 본문 하단에도 동일한 취지를 명시한다.
 *
 * 한글 렌더링을 위해 Noto Sans KR 정적 인스턴스(Regular/Bold)를 assets/fonts에
 * 번들해 등록한다. @react-pdf/renderer(fontkit 기반)는 가변 폰트의 굵기 축을
 * 제대로 반영하지 못해 굳이 두 정적 인스턴스로 분리했다.
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

  // react-pdf가 자간 커닝 테이블 조회 중 던지는 경고를 콘솔에서 침묵시킨다 — 렌더링엔 영향 없음.
  Font.registerHyphenationCallback((word) => [word]);

  fontRegistered = true;
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

function PartyBox({ label, party }: { label: string; party: StatementParty }) {
  const rows: Array<[string, string]> = [
    ["상호", party.name],
    ["대표자", party.representativeName ?? "-"],
    ["사업자번호", party.businessNumber ?? "-"],
    ["주소", party.address ?? "-"],
    ["연락처", party.phone ?? "-"],
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

function TransactionStatementDocument({ data }: { data: StatementData }) {
  const issuedAt = new Date().toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return (
    <Document title={`거래명세서_${data.orderNumber}`}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>거래명세서</Text>
        <Text style={styles.subtitle}>Transaction Statement</Text>

        <View style={styles.metaRow}>
          <Text>발주번호: {data.orderNumber}</Text>
          <Text>발주일시: {formatOrderedAt(data.orderedAt)}</Text>
          <Text>발행일: {issuedAt}</Text>
        </View>

        <View style={styles.partyRow}>
          <PartyBox label="공급자" party={data.supplier} />
          <PartyBox label="공급받는자" party={data.buyer} />
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
          <Text style={styles.totalLabel}>합계금액</Text>
          <Text style={styles.totalValue}>{formatWon(data.totalAmount)}</Text>
        </View>

        <View style={styles.partyBox}>
          <Text style={styles.partyLabel}>배송지</Text>
          <Text style={styles.partyValue}>{data.deliveryAddress || "-"}</Text>
        </View>

        {data.deliveryNotes && (
          <View style={[styles.notesBox, { marginTop: 12 }]}>
            <Text>배송 요청사항: {data.deliveryNotes}</Text>
          </View>
        )}

        <Text style={styles.disclaimer}>
          본 문서는 플랫폼에 적재된 발주 데이터를 기준으로 자동 생성된 거래명세서이며, 부가가치세법상
          세금계산서를 대체하지 않습니다. 세금계산서는 공급자(도매업자)가 별도로 발행합니다.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderTransactionStatementPdf(data: StatementData): Promise<Buffer> {
  registerFontOnce();

  return renderToBuffer(<TransactionStatementDocument data={data} />);
}
