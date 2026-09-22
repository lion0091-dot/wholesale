"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buildPriceCsv, parsePriceCsv, type PriceCsvProduct } from "@/lib/products/price-import";
import { bulkUpdateProductPricesAction, type BulkPriceResult } from "./actions";

/**
 * 판매가 일괄 등록.
 *
 * 스캔으로 자동 등록된 상품은 판매가가 0원이라 고객에게 안 보인다. 수십 개를
 * 하나씩 고치는 대신 CSV로 내려받아 엑셀에서 채우고 다시 올린다.
 */
interface Props {
  /** 판매가가 비어 있는 상품들 (보관 제외) */
  unpricedProducts: PriceCsvProduct[];
}

export function PriceBulkPanel({ unpricedProducts }: Props) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [activate, setActivate] = useState(true);
  const [pending, setPending] = useState<Array<{ id: string; price: number }>>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [result, setResult] = useState<BulkPriceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDownload = () => {
    const csv = buildPriceCsv(unpricedProducts);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `판매가입력_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();

    URL.revokeObjectURL(url);
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;

    setResult(null);
    setError(null);

    if (/\.xlsx?$/i.test(file.name)) {
      setError("엑셀 파일(.xlsx)은 읽을 수 없습니다. 엑셀에서 '다른 이름으로 저장 > CSV'로 저장해주세요.");
      return;
    }

    const parsed = parsePriceCsv(await file.text());

    setPending(
      parsed.rows
        .filter((row) => !row.error && row.price !== null)
        .map((row) => ({ id: row.id, price: row.price as number }))
    );

    setIssues(
      parsed.rows
        .filter((row) => row.error)
        .slice(0, 5)
        .map((row) => `${row.rowNo}번째 줄: ${row.error}`)
    );

    if (parsed.filledCount === 0 && parsed.errorCount === 0) {
      setError("판매가가 채워진 줄이 없습니다.");
    }
  };

  const handleApply = async () => {
    if (pending.length === 0) {
      setError("반영할 판매가가 없습니다.");
      return;
    }

    setBusy(true);
    setError(null);

    const applied = await bulkUpdateProductPricesAction(pending, activate);

    setBusy(false);

    if (!applied.success || !applied.data) {
      setError(applied.error ?? "반영에 실패했습니다.");
      return;
    }

    setResult(applied.data);
    setPending([]);
    setIssues([]);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    router.refresh();
  };

  return (
    <section style={panelStyle}>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>판매가 일괄 등록</span>
        <span style={{ fontSize: "11px", color: "#94a3b8" }}>
          판매가 미설정 {unpricedProducts.length}건
        </span>
        <span style={{ marginLeft: "auto", fontSize: "12px", color: "#64748b" }}>
          {open ? "접기" : "열기"}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <ol style={{ fontSize: "12px", color: "#475569", lineHeight: 1.8, paddingLeft: "18px", margin: 0 }}>
            <li>아래 버튼으로 CSV를 내려받습니다 (공공 시세가 참고로 들어 있습니다).</li>
            <li>엑셀에서 맨 오른쪽 <strong>“판매가”</strong> 칸만 채웁니다. <strong>상품ID는 건드리지 마세요.</strong></li>
            <li>CSV로 저장한 뒤 다시 올립니다.</li>
          </ol>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              onClick={handleDownload}
              disabled={unpricedProducts.length === 0}
              style={{
                ...buttonStyle,
                backgroundColor: unpricedProducts.length > 0 ? "#0f172a" : "#e2e8f0",
                color: unpricedProducts.length > 0 ? "#fff" : "#94a3b8",
                border: "none",
              }}
            >
              내려받기 ({unpricedProducts.length}건)
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
              style={{ fontSize: "13px" }}
            />
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#475569" }}>
            <input
              type="checkbox"
              checked={activate}
              onChange={(event) => setActivate(event.target.checked)}
            />
            판매가를 넣은 상품을 <strong>판매중</strong>으로 함께 전환
          </label>

          {pending.length > 0 && (
            <div
              style={{
                border: "1px solid #bfdbfe",
                backgroundColor: "#eff6ff",
                borderRadius: "8px",
                padding: "10px 12px",
                fontSize: "13px",
                color: "#1e3a8a",
              }}
            >
              판매가가 채워진 줄 <strong>{pending.length}건</strong>을 반영할 수 있습니다.
            </div>
          )}

          {issues.length > 0 && (
            <div style={{ fontSize: "12px", color: "#b45309" }}>
              {issues.map((issue) => (
                <div key={issue}>{issue}</div>
              ))}
            </div>
          )}

          <div>
            <button
              type="button"
              disabled={busy || pending.length === 0}
              onClick={() => void handleApply()}
              style={{
                ...buttonStyle,
                backgroundColor: pending.length > 0 && !busy ? "#0f172a" : "#e2e8f0",
                color: pending.length > 0 && !busy ? "#fff" : "#94a3b8",
                border: "none",
              }}
            >
              {busy ? "반영 중…" : `${pending.length}건 반영`}
            </button>
          </div>

          {result && (
            <div
              style={{
                backgroundColor: "#dcfce7",
                color: "#166534",
                borderRadius: "8px",
                padding: "10px 12px",
                fontSize: "13px",
              }}
            >
              {result.updated}건 반영했습니다.
              {result.skipped > 0 && ` · 빈 칸 ${result.skipped}건 건너뜀`}
              {result.notFound > 0 && ` · 찾지 못함 ${result.notFound}건`}
            </div>
          )}

          {error && (
            <div
              style={{
                backgroundColor: "#fee2e2",
                color: "#991b1b",
                borderRadius: "8px",
                padding: "10px 12px",
                fontSize: "13px",
              }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  backgroundColor: "#fff",
  padding: "14px",
  marginBottom: "14px",
};

const buttonStyle: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: "13px",
  fontWeight: 600,
  borderRadius: "6px",
  border: "1px solid #e2e8f0",
  backgroundColor: "#f8fafc",
  color: "#334155",
  cursor: "pointer",
};
