/**
 * 이력번호 1건을 실제 API로 조회해 구조를 확인하는 일회용 도구(소 로트 응답 검증용, 2026-10-01).
 * 사용: node --env-file=.env.local node_modules/.bin/tsx scripts/lookup-trace-once.ts L02011163016114
 * 키는 출력하지 않는다. raw_payload는 개체(item)별 주요 필드만 표로 찍는다.
 */
import { fetchTraceRecord } from "@/lib/livestock/mtrace-client";

function collectItems(tree: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(tree)) {
    for (const node of tree) collectItems(node, out);
  } else if (tree && typeof tree === "object") {
    const record = tree as Record<string, unknown>;

    if ("cattleNo" in record || "pigNo" in record) out.push(record);
    for (const value of Object.values(record)) collectItems(value, out);
  }

  return out;
}

async function main() {
  const traceNo = process.argv[2];

  if (!traceNo) throw new Error("이력번호를 인자로 주세요.");

  const record = await fetchTraceRecord(traceNo);

  if (!record) {
    console.log("결과 없음(NOT_FOUND)");

    return;
  }

  const { rawPayload, ...summary } = record;

  console.log("요약:", JSON.stringify(summary, null, 1));

  const items = collectItems(rawPayload);

  console.log(`구성 개체 ${items.length}건`);
  console.table(
    items.map((item) => ({
      cattleNo: item.cattleNo ?? item.pigNo,
      grade: item.cattleGradeNm ?? item.gradeNm ?? item.qgradeNm,
      bms: item.insfat,
      sex: item.sexNm,
      breed: item.lsTypeNm,
      butchery: item.butcheryYmd,
      farm: item.farmNm,
      place: item.butcheryPlaceNm,
    }))
  );

  if (items[0]) console.log("첫 개체 필드:", Object.keys(items[0]).join(", "));
}

main().catch((error) => {
  console.error("실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
