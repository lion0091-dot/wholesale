/**
 * 배송의뢰서(Delivery Request) 서버사이드 PDF 렌더러.
 *
 * ⚠️ 이 문서는 운송장이 아니다 — 플랫폼은 운송장 발급을 대행하지 않는다
 * (docs/delivery-tracking.md 잠긴 결정). 화물기사님/택배사에 무엇을 얼마나
 * 어디로 보내는지 전달하기 위한 참고 문서일 뿐이다. 가격 정보는 담지 않는다.
 *
 * 폰트 등록은 lib/pdf/transaction-statement.tsx와 별도 모듈 스코프를 쓴다 —
 * react-pdf의 Font.register는 family명 기준 전역 레지스트리라 같은 family를
 * 다시 등록해도 안전하지만, 모듈별로 독립된 registered 플래그를 둬야
 * 번들링 순서와 무관하게 항상 등록을 보장한다.
 */

import path from "node:path";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { formatOrderedAt } from "@/lib/orders/status";
import type { StatementParty } from "@/lib/orders/statement";
import type { DeliveryRequestData } from "@/lib/orders/delivery-request";

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
  cellQty: { width: 90, padding: 6, textAlign: "right" },
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
    ["담당자", party.representativeName ?? "-"],
    ["연락처", party.phone ?? "-"],
    ["주소", party.address ?? "-"],
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

function DeliveryRequestDocument({ data }: { data: DeliveryRequestData }) {
  const issuedAt = new Date().toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return (
    <Document title={`배송의뢰서_${data.orderNumber}`}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>배송의뢰서</Text>
        <Text style={styles.subtitle}>Delivery Request</Text>

        <View style={styles.metaRow}>
          <Text>발주번호: {data.orderNumber}</Text>
          <Text>발주일시: {formatOrderedAt(data.orderedAt)}</Text>
          <Text>작성일: {issuedAt}</Text>
        </View>

        <View style={styles.partyRow}>
          <PartyBox label="보내는 곳" party={data.sender} />
          <PartyBox label="받는 곳" party={data.receiver} />
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.cellNo, styles.headerCell]}>No</Text>
            <Text style={[styles.cellName, styles.headerCell]}>품목명</Text>
            <Text style={[styles.cellQty, styles.headerCell]}>수량</Text>
          </View>
          {data.items.map((item, index) => (
            <View key={`${item.productName}-${index}`} style={styles.tableRow}>
              <Text style={styles.cellNo}>{index + 1}</Text>
              <Text style={styles.cellName}>{item.productName}</Text>
              <Text style={styles.cellQty}>
                {item.quantity}
                {item.unit}
              </Text>
            </View>
          ))}
        </View>

        {data.totalWeightKg != null && (
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>총 중량(kg 품목 합계, 참고용)</Text>
            <Text style={styles.totalValue}>{data.totalWeightKg}kg</Text>
          </View>
        )}

        {data.deliveryNotes && (
          <View style={styles.notesBox}>
            <Text>배송 요청사항: {data.deliveryNotes}</Text>
          </View>
        )}

        <Text style={styles.disclaimer}>
          본 문서는 플랫폼에 적재된 발주 데이터를 기준으로 자동 생성된 배송 의뢰 참고 문서이며,
          운송장이나 법적 운송계약서가 아닙니다. 실제 배송 접수/계약은 공급사와 운송사(택배사·화물차주)
          사이에서 별도로 이뤄집니다. 가격 정보는 포함하지 않습니다.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderDeliveryRequestPdf(data: DeliveryRequestData): Promise<Buffer> {
  registerFontOnce();

  return renderToBuffer(<DeliveryRequestDocument data={data} />);
}
