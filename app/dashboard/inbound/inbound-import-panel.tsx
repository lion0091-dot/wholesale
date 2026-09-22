"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseImportTable, type ImportRow } from "@/lib/livestock/import-parser";
import {
  createImportJobAction,
  processImportChunkAction,
  findUnfinishedImportJobAction,
  type ImportJobProgress,
} from "./actions";

/**
 * 엑셀 대량 입고.
 *
 * npm 레지스트리가 이 환경에서 막혀 .xlsx 파서를 넣을 수 없다. 대신 엑셀에서
 * 바로 나오는 두 경로를 받는다 — CSV 파일, 그리고 범위를 복사해 붙여넣기.
 *
 * 처리는 브라우저가 청크를 반복 호출하는 방식이다(Hobby 크론 제약). 창을 닫아도
 * 작업이 DB에 남아 다시 들어오면 이어서 처리할 수 있다.
 */
export function InboundImportPanel() {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [progress, setProgress] = useState<ImportJobProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 새로고침·재접속 시 끝나지 않은 작업이 있으면 이어받는다.
  useEffect(() => {
    void findUnfinishedImportJobAction().then((result) => {
      if (result.success && result.data) {
        setProgress(result.data);
        setOpen(true);
      }
    });
  }, []);

  const applyText = (text: string, name: string) => {
    const parsed = parseImportTable(text);

    setRows(parsed.rows);
    setFileName(name);
    setError(
      parsed.rows.length === 0 ? "읽을 수 있는 줄이 없습니다. 형식을 확인해주세요." : null
    );
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;

    if (/\.xlsx?$/i.test(file.name)) {
      setError(
        "엑셀 파일(.xlsx)은 직접 읽을 수 없습니다. 엑셀에서 '다른 이름으로 저장 > CSV'로 저장하거나, 표 범위를 복사해 아래 칸에 붙여넣어주세요."
      );
      return;
    }

    applyText(await file.text(), file.name);
  };

  /** finished가 될 때까지 청크를 반복 호출한다. */
  const drain = async (jobId: string) => {
    setRunning(true);

    for (;;) {
      const result = await processImportChunkAction(jobId);

      if (!result.success || !result.data) {
        setError(result.error ?? "처리 중 오류가 발생했습니다.");
        break;
      }

      setProgress(result.data);

      if (result.data.finished) {
        break;
      }
    }

    setRunning(false);
    router.refresh();
  };

  const handleUpload = async () => {
    const validRows = rows.filter((row) => !row.error && row.weight);

    if (validRows.length === 0) {
      setError("올릴 수 있는 줄이 없습니다.");
      return;
    }

    setError(null);

    const created = await createImportJobAction({
      fileName: fileName || "붙여넣기",
      rows: validRows.map((row) => ({
        rowNo: row.rowNo,
        traceNo: row.traceNo,
        weight: row.weight as number,
      })),
    });

    if (!created.success || !created.data) {
      setError(created.error ?? "업로드에 실패했습니다.");
      return;
    }

    setRows([]);
    setPasted("");
    setFileName("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    setProgress(created.data);
    await drain(created.data.jobId);
  };

  const validCount = rows.filter((row) => !row.error).length;
  const errorRows = rows.filter((row) => row.error);

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
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>엑셀 대량 입고</span>
        <span style={{ fontSize: "11px", color: "#94a3b8" }}>
          CSV 파일 또는 엑셀에서 복사·붙여넣기
        </span>
        <span style={{ marginLeft: "auto", fontSize: "12px", color: "#64748b" }}>
          {open ? "접기" : "열기"}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {progress && (
            <div
              style={{
                border: "1px solid #bfdbfe",
                backgroundColor: "#eff6ff",
                borderRadius: "8px",
                padding: "12px 14px",
              }}
            >
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#1e40af", marginBottom: "6px" }}>
                {progress.finished ? "처리 완료" : running ? "처리 중…" : "이어서 처리할 작업이 있습니다"}
              </div>
              <div style={{ fontSize: "12px", color: "#1e3a8a" }}>
                {progress.done + progress.failed} / {progress.total}건
                {progress.failed > 0 && ` · 실패 ${progress.failed}건`}
              </div>
              <div
                style={{
                  height: "6px",
                  borderRadius: "3px",
                  backgroundColor: "#dbeafe",
                  marginTop: "8px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, ((progress.done + progress.failed) / Math.max(1, progress.total)) * 100)}%`,
                    height: "100%",
                    backgroundColor: "#2563eb",
                  }}
                />
              </div>

              {!progress.finished && !running && (
                <button
                  type="button"
                  onClick={() => void drain(progress.jobId)}
                  style={{ ...buttonStyle, marginTop: "10px" }}
                >
                  이어서 처리
                </button>
              )}
            </div>
          )}

          <div>
            <label htmlFor="import_file" style={labelStyle}>
              CSV 파일
            </label>
            <input
              ref={fileInputRef}
              id="import_file"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
              style={{ fontSize: "13px" }}
            />
          </div>

          <div>
            <label htmlFor="import_paste" style={labelStyle}>
              또는 엑셀에서 복사해 붙여넣기
            </label>
            <textarea
              id="import_paste"
              value={pasted}
              onChange={(event) => {
                setPasted(event.target.value);
                applyText(event.target.value, "붙여넣기");
              }}
              rows={5}
              placeholder={"002123456789\t8.2\n002999888777\t7.5"}
              style={{
                width: "100%",
                padding: "10px",
                fontSize: "13px",
                fontFamily: "monospace",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
              }}
            />
            <p style={{ fontSize: "11px", color: "#94a3b8", margin: "4px 0 0" }}>
              첫 칸은 이력번호(바코드 값 그대로도 됩니다), 둘째 칸은 중량입니다. 머리글 줄은 자동으로 건너뜁니다.
            </p>
          </div>

          {rows.length > 0 && (
            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                padding: "10px 12px",
                fontSize: "12px",
                color: "#475569",
              }}
            >
              <div style={{ fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>
                읽은 결과: 정상 {validCount}건
                {errorRows.length > 0 && ` · 건너뜀 ${errorRows.length}건`}
              </div>

              {errorRows.slice(0, 5).map((row) => (
                <div key={row.rowNo} style={{ color: "#b45309" }}>
                  {row.rowNo}번째 줄: {row.error} — {row.raw.slice(0, 40)}
                </div>
              ))}
              {errorRows.length > 5 && (
                <div style={{ color: "#94a3b8" }}>…외 {errorRows.length - 5}건</div>
              )}
            </div>
          )}

          <div>
            <button
              type="button"
              disabled={running || validCount === 0}
              onClick={() => void handleUpload()}
              style={{
                ...buttonStyle,
                backgroundColor: validCount > 0 && !running ? "#0f172a" : "#e2e8f0",
                color: validCount > 0 && !running ? "#fff" : "#94a3b8",
                border: "none",
              }}
            >
              {running ? "처리 중…" : `${validCount}건 입고 처리`}
            </button>
          </div>

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
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "#475569",
  marginBottom: "4px",
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
