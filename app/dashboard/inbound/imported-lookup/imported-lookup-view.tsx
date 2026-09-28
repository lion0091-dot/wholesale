"use client";

import { useState } from "react";
import { searchImportedTraceAction } from "../actions";

interface ImportedTraceRecordView {
  distributionId: string;
  productCode: string | null;
  productName: string | null;
  blNo: string | null;
  status: string | null;
  importDate: string | null;
  originCode: string | null;
  originCountry: string | null;
  quantity: number | null;
  weight: number | null;
  exportSlaughterStart: string | null;
  exportSlaughterEnd: string | null;
  distributionLimitEnd: string | null;
  sold: string | null;
}

const panelStyle: React.CSSProperties = { border: "1px solid #e2e8f0", borderRadius: "12px", backgroundColor: "#fff", padding: "14px" };
const labelStyle: React.CSSProperties = { fontSize: "12px", fontWeight: 700, color: "#475569", display: "block", marginBottom: "4px" };
const inputStyle: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  padding: "8px 10px",
  fontSize: "13px",
  width: "100%",
  boxSizing: "border-box",
};
const primaryButton: React.CSSProperties = {
  border: "none",
  borderRadius: "8px",
  backgroundColor: "#0f172a",
  color: "#fff",
  fontSize: "13px",
  fontWeight: 700,
  padding: "10px 16px",
  cursor: "pointer",
};

function todayYYYYMMDD(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ImportedLookupView() {
  const [importDate, setImportDate] = useState(todayYYYYMMDD());
  const [productName, setProductName] = useState("");
  const [blNo, setBlNo] = useState("");
  const [originNation, setOriginNation] = useState("");
  const [findNo, setFindNo] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<ImportedTraceRecordView[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const handleSearch = async () => {
    setLoading(true);
    setError(null);

    const result = await searchImportedTraceAction({
      importDate,
      productName: productName || undefined,
      blNo: blNo || undefined,
      originNation: originNation || undefined,
    });

    setLoading(false);

    if (!result.success || !result.data) {
      setError(result.error ?? "조회에 실패했습니다.");
      setRecords(null);
      return;
    }

    setRecords(result.data.records);
    setTotalCount(result.data.totalCount);
    setTruncated(result.data.truncated);
  };

  const target = findNo.trim();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={panelStyle}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
          <div>
            <label style={labelStyle}>수입일자 (필수)</label>
            <input type="date" value={importDate} onChange={(e) => setImportDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>찾는 번호 (선택)</label>
            <input
              value={findNo}
              onChange={(e) => setFindNo(e.target.value)}
              placeholder="박스에 적힌 유통식별번호"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>품목명 (선택)</label>
            <input value={productName} onChange={(e) => setProductName(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>선하증권번호 (선택)</label>
            <input value={blNo} onChange={(e) => setBlNo(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>원산지 국가 (선택)</label>
            <input value={originNation} onChange={(e) => setOriginNation(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ marginTop: "12px" }}>
          <button type="button" onClick={handleSearch} disabled={loading || !importDate} style={primaryButton}>
            {loading ? "조회 중..." : "조회"}
          </button>
        </div>

        {error && <p style={{ color: "#b91c1c", fontSize: "13px", marginTop: "10px" }}>{error}</p>}
      </div>

      {records !== null && (
        <div style={panelStyle}>
          <p style={{ fontSize: "13px", color: "#475569", margin: "0 0 10px" }}>
            총 {totalCount.toLocaleString("ko-KR")}건 중 {records.length.toLocaleString("ko-KR")}건 표시
            {truncated && " — 결과가 많아 일부만 받았습니다. 품목명·선하증권번호로 좁혀서 다시 조회하세요."}
          </p>

          {target && !records.some((r) => r.distributionId === target) && (
            <p style={{ color: "#b45309", fontSize: "13px", marginBottom: "10px" }}>
              &quot;{target}&quot; 번호는 이 목록에 없습니다. 수입일자를 다시 확인해주세요.
            </p>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>
                  <th style={{ padding: "6px" }}>유통식별번호</th>
                  <th style={{ padding: "6px" }}>품목명</th>
                  <th style={{ padding: "6px" }}>원산지</th>
                  <th style={{ padding: "6px" }}>수량/중량</th>
                  <th style={{ padding: "6px" }}>선하증권번호</th>
                  <th style={{ padding: "6px" }}>유통기한</th>
                  <th style={{ padding: "6px" }}>상태</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const matched = target !== "" && r.distributionId === target;
                  return (
                    <tr
                      key={r.distributionId}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        backgroundColor: matched ? "#fef9c3" : undefined,
                      }}
                    >
                      <td style={{ padding: "6px", fontWeight: matched ? 800 : 400 }}>{r.distributionId}</td>
                      <td style={{ padding: "6px" }}>{r.productName ?? "-"}</td>
                      <td style={{ padding: "6px" }}>{r.originCountry ?? "-"}</td>
                      <td style={{ padding: "6px" }}>
                        {r.quantity ?? "-"} / {r.weight ?? "-"}
                      </td>
                      <td style={{ padding: "6px" }}>{r.blNo ?? "-"}</td>
                      <td style={{ padding: "6px" }}>{r.distributionLimitEnd ?? "-"}</td>
                      <td style={{ padding: "6px" }}>{r.status ?? "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {records.length === 0 && (
            <p style={{ fontSize: "13px", color: "#64748b" }}>해당 날짜·조건에 맞는 수입 이력이 없습니다.</p>
          )}
        </div>
      )}
    </div>
  );
}
