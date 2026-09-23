"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  applyColumnMap,
  buildGrid,
  parseDocumentText,
  type ColumnMap,
  type DocumentField,
  type DocumentGrid,
  type DocumentLine,
} from "@/lib/livestock/document-parser";
import { buildGapReport, buildSupplierRequestSummary } from "@/lib/livestock/document-requirements";
import {
  extractDocumentTableAction,
  loadSupplierFormatAction,
  saveInboundDocumentAction,
  type DocumentLineInput,
} from "./document-actions";
import type { ScanProductOption } from "./inbound-scan-view";

/**
 * 공급처 명세서 올리기 (29단계 A).
 *
 * 서류가 들어오는 길이 여러 갈래다 — 이메일로 온 엑셀/CSV, 현장에서 받은 종이를
 * 찍은 사진, PDF. 사진은 글자 정보가 아예 없고 PDF도 뽑기가 무거워서, 자동으로
 * 읽는 건 엑셀·CSV·붙여넣기까지만 한다. 사진·PDF는 원본을 옆에 띄워놓고 보면서
 * 입력한다(잠긴 결정 — 실제 서류를 보고 자동 읽기 가치를 판단한 뒤 재검토).
 *
 * 어느 길로 들어오든 마지막은 같다: 표를 사람이 확인하고, 플랫폼 기준에 견줘
 * 뭐가 빠졌는지 보고, 저장한다. 재고는 만들지 않는다.
 */

const FIELD_LABELS: Record<DocumentField, string> = {
  itemName: "품목",
  traceNo: "이력번호",
  quantity: "수량",
  labeledWeight: "중량(kg)",
  unitPrice: "단가",
  amount: "금액",
};

const FIELD_ORDER: DocumentField[] = [
  "itemName",
  "traceNo",
  "quantity",
  "labeledWeight",
  "unitPrice",
  "amount",
];

const SOURCE_BADGE: Record<string, { text: string; bg: string; fg: string }> = {
  FROM_SUPPLIER: { text: "공급처에 요청", bg: "#fee2e2", fg: "#991b1b" },
  FROM_STAFF: { text: "여기서 고르면 됨", bg: "#dbeafe", fg: "#1e40af" },
  FROM_SCAN: { text: "찍으면 채워짐", bg: "#e0e7ff", fg: "#3730a3" },
};

/**
 * idle      — 아직 아무것도 안 고름
 * review    — 표를 읽어냈고 사람이 확인하는 중
 * storeOnly — 글자를 못 읽는 서류(사진·스캔본 PDF). 원본만 보관한다.
 */
type Mode = "idle" | "review" | "storeOnly";

interface EditableLine extends DocumentLine {
  productId: string | null;
}

function emptyLine(lineNo: number): EditableLine {
  return {
    lineNo,
    raw: "",
    itemName: null,
    traceNo: null,
    quantity: null,
    labeledWeight: null,
    unitPrice: null,
    amount: null,
    productId: null,
  };
}

function toNumber(value: string): number | null {
  const cleaned = value.replace(/,/g, "").trim();

  if (!cleaned) return null;

  const parsed = Number.parseFloat(cleaned);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function InboundDocumentPanel({ products }: { products: ScanProductOption[] }) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  const [entryMethod, setEntryMethod] = useState<"AUTO" | "MANUAL">("AUTO");

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");

  const [grid, setGrid] = useState<DocumentGrid | null>(null);
  const [columnMap, setColumnMap] = useState<ColumnMap>({});
  const [lines, setLines] = useState<EditableLine[]>([]);

  const [supplierName, setSupplierName] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [documentNo, setDocumentNo] = useState("");
  const [totalAmount, setTotalAmount] = useState("");

  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [storeOnlyReason, setStoreOnlyReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [learned, setLearned] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // 사진 미리보기는 브라우저 메모리를 잡으므로 바뀔 때마다 풀어준다.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const gapReport = useMemo(
    () =>
      buildGapReport(
        {
          supplierName,
          issuedOn: issuedOn || null,
          totalAmount: toNumber(totalAmount),
        },
        lines,
        lines.map((line) => ({ lineNo: line.lineNo, productId: line.productId })),
      ),
    [supplierName, issuedOn, totalAmount, lines],
  );

  const supplierRequests = useMemo(
    () => buildSupplierRequestSummary(gapReport),
    [gapReport],
  );

  const reset = () => {
    setMode("idle");
    setEntryMethod("AUTO");
    setFile(null);
    setPreviewUrl(null);
    setPasted("");
    setGrid(null);
    setColumnMap({});
    setLines([]);
    setSupplierName("");
    setIssuedOn("");
    setDocumentNo("");
    setTotalAmount("");
    setError(null);
    setLearned(false);
    setStoreOnlyReason("");
    setExtracting(false);

    if (fileInputRef.current) fileInputRef.current.value = "";
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  const startFromGrid = (parsed: DocumentGrid, sourceFile: File | null) => {
    const built = applyColumnMap(parsed, parsed.columnMap);

    if (built.length === 0) {
      if (sourceFile) {
        startStoreOnly(sourceFile, "품목 줄을 찾지 못해 원본만 보관합니다.");
      } else {
        setError("읽을 수 있는 품목 줄이 없습니다. 형식을 확인해주세요.");
      }
      return;
    }

    setGrid(parsed);
    setColumnMap(parsed.columnMap);
    setLines(built.map((line) => ({ ...line, productId: null })));
    setFile(sourceFile);
    setEntryMethod("AUTO");
    setMode("review");
    setError(null);
  };

  const startFromText = (text: string, sourceFile: File | null) => {
    startFromGrid(parseDocumentText(text), sourceFile);
  };

  /**
   * 글자를 못 읽는 서류는 원본만 보관한다.
   * 입고 화면에서 손으로 받아적게 만들지 않는다(잠긴 결정) — 현장 화면은
   * 바코드 찍는 데 집중해야 하고, 받아적기는 그 자리에서 할 일이 아니다.
   */
  const startStoreOnly = (sourceFile: File, why: string) => {
    if (sourceFile.type.startsWith("image/")) {
      setPreviewUrl(URL.createObjectURL(sourceFile));
    }

    setFile(sourceFile);
    setGrid(null);
    setColumnMap({});
    setLines([]);
    setEntryMethod("MANUAL");
    setMode("storeOnly");
    setNotice(null);
    setError(null);
    setStoreOnlyReason(why);
  };

  const handleFile = async (picked: File | null) => {
    if (!picked) return;

    setError(null);

    if (picked.size > 8 * 1024 * 1024) {
      setError("파일이 너무 큽니다. 8MB 이하로 올려주세요.");
      return;
    }

    // 사진은 글자 정보가 아예 없다. 읽으려는 시도조차 하지 않는다.
    if (picked.type.startsWith("image/")) {
      startStoreOnly(picked, "사진은 글자를 읽어낼 수 없어 원본만 보관합니다.");
      return;
    }

    if (/\.xlsx?$/i.test(picked.name)) {
      setError(
        "엑셀 파일(.xlsx)은 바로 읽을 수 없습니다. 엑셀에서 '다른 이름으로 저장 > CSV'로 저장하시거나, 표를 복사해 아래 칸에 붙여넣어주세요.",
      );
      return;
    }

    // PDF는 컴퓨터에서 만든 것이면 글자가 들어 있어 표를 되살릴 수 있고,
    // 종이를 스캔하거나 사진을 PDF로 바꾼 것이면 글자가 없다. 서버에서 확인한다.
    if (/\.pdf$/i.test(picked.name) || picked.type === "application/pdf") {
      setExtracting(true);

      const formData = new FormData();

      formData.append("file", picked);

      const result = await extractDocumentTableAction(formData);

      setExtracting(false);

      if (!result.success || !result.data) {
        startStoreOnly(picked, result.error ?? "PDF를 읽지 못해 원본만 보관합니다.");
        return;
      }

      if (result.data.cells.length === 0) {
        startStoreOnly(
          picked,
          result.data.hasText
            ? "이 PDF에서 표를 찾지 못해 원본만 보관합니다."
            : "종이를 스캔하거나 사진으로 만든 PDF라 글자가 없습니다. 원본만 보관합니다.",
        );
        return;
      }

      startFromGrid(buildGrid(result.data.cells), picked);
      return;
    }

    startFromText(await picked.text(), picked);
  };

  /** 공급처 이름을 벗어날 때, 전에 이 공급처 서류를 읽어본 적 있으면 그 칸 위치를 되살린다. */
  const recallFormat = async () => {
    if (!supplierName.trim() || !grid) return;

    const result = await loadSupplierFormatAction(supplierName);

    if (result.success && result.data?.columnMap) {
      const recalled = result.data.columnMap as ColumnMap;

      if (Object.keys(recalled).length === 0) return;

      setColumnMap(recalled);
      setLines(
        applyColumnMap(grid, recalled).map((line) => ({ ...line, productId: null })),
      );
      setLearned(true);
    }
  };

  const changeColumn = (field: DocumentField, value: string) => {
    if (!grid) return;

    const next: ColumnMap = { ...columnMap };

    if (value === "") {
      delete next[field];
    } else {
      next[field] = Number(value);
    }

    setColumnMap(next);
    setLines(applyColumnMap(grid, next).map((line) => ({ ...line, productId: null })));
  };

  const updateLine = (lineNo: number, patch: Partial<EditableLine>) => {
    setLines((current) =>
      current.map((line) => (line.lineNo === lineNo ? { ...line, ...patch } : line)),
    );
  };

  const removeLine = (lineNo: number) => {
    setLines((current) =>
      current
        .filter((line) => line.lineNo !== lineNo)
        .map((line, index) => ({ ...line, lineNo: index + 1 })),
    );
  };

  const handleSave = async () => {
    setError(null);

    const usable =
      mode === "storeOnly"
        ? []
        : lines.filter((line) => line.itemName || line.traceNo || line.labeledWeight !== null);

    if (mode !== "storeOnly" && usable.length === 0) {
      setError("저장할 품목이 없습니다.");
      return;
    }

    if (!supplierName.trim()) {
      setError("공급처 이름을 입력해주세요.");
      return;
    }

    setSaving(true);

    const payload = {
      supplierName,
      documentNo: documentNo || null,
      issuedOn: issuedOn || null,
      totalAmount: toNumber(totalAmount),
      entryMethod,
      columnMap: entryMethod === "AUTO" ? (columnMap as Record<string, number>) : null,
      sampleHeader:
        grid?.headerRowIndex !== null && grid?.headerRowIndex !== undefined
          ? grid.cells[grid.headerRowIndex].join(" | ")
          : null,
      lines: usable.map<DocumentLineInput>((line) => ({
        lineNo: line.lineNo,
        raw: line.raw,
        itemName: line.itemName,
        productId: line.productId,
        traceNo: line.traceNo,
        quantity: line.quantity,
        labeledWeight: line.labeledWeight,
        unitPrice: line.unitPrice,
        amount: line.amount,
      })),
    };

    const formData = new FormData();

    formData.append("payload", JSON.stringify(payload));

    if (file) formData.append("file", file);

    const result = await saveInboundDocumentAction(formData);

    setSaving(false);

    if (!result.success) {
      setError(result.error ?? "저장하지 못했습니다.");
      return;
    }

    if (result.data?.fileStored === false && file) {
      setNotice("내용은 저장했지만 원본 파일은 보관하지 못했습니다 — 원본만 다시 올려주세요.");
    } else if ((result.data?.lineCount ?? 0) === 0) {
      setNotice("원본을 보관했습니다. 품목 내용은 읽지 못해 비어 있습니다.");
    } else {
      setNotice(`명세서 ${result.data?.lineCount}줄을 저장했습니다.`);
    }

    reset();
    router.refresh();
  };

  const columnCount = grid?.cells.reduce((max, row) => Math.max(max, row.length), 0) ?? 0;

  return (
    <section
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        backgroundColor: "#ffffff",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "14px 16px",
          border: "none",
          backgroundColor: "#f8fafc",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span>
          <span style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
            공급처 명세서 올리기
          </span>
          <span style={{ display: "block", fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
            이메일로 받은 파일이나 현장에서 받은 종이를 찍어 올리면, 플랫폼 기준에 맞춰 넣고
            빠진 항목을 알려드립니다. 재고는 박스를 찍어야 잡힙니다.
          </span>
        </span>
        <span style={{ fontSize: "13px", color: "#64748b", flexShrink: 0 }}>
          {open ? "접기" : "열기"}
        </span>
      </button>

      {notice ? (
        <p
          style={{
            margin: 0,
            padding: "10px 16px",
            fontSize: "13px",
            color: "#065f46",
            backgroundColor: "#ecfdf5",
            borderTop: "1px solid #a7f3d0",
          }}
        >
          {notice}
        </p>
      ) : null}

      {open ? (
        <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
          {error ? (
            <p
              style={{
                margin: 0,
                padding: "10px 12px",
                fontSize: "13px",
                color: "#991b1b",
                backgroundColor: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "8px",
              }}
            >
              {error}
            </p>
          ) : null}

          {mode === "idle" ? (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  style={primaryButton}
                >
                  사진 찍어 올리기
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  style={secondaryButton}
                >
                  파일 고르기 (CSV · PDF · 사진)
                </button>
              </div>

              {extracting ? (
                <p style={{ margin: 0, fontSize: "13px", color: "#1e40af" }}>
                  PDF에서 표를 읽는 중입니다…
                </p>
              ) : null}

              {/* 현장에서 종이를 받은 경우 — 폰이면 바로 카메라가 열린다.
                  PC에서는 capture가 무시되고 일반 파일 선택으로 동작한다. */}
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
                style={{ display: "none" }}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt,.pdf,image/*"
                onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
                style={{ display: "none" }}
              />

              <div>
                <label style={labelStyle}>엑셀에서 표를 복사해 붙여넣기</label>
                <textarea
                  value={pasted}
                  onChange={(event) => setPasted(event.target.value)}
                  rows={4}
                  placeholder={"품목\t중량\t단가\t금액\n삼겹살\t10.5\t18000\t189000"}
                  style={{ ...inputStyle, fontFamily: "monospace", resize: "vertical" }}
                />
                <button
                  type="button"
                  onClick={() => startFromText(pasted, null)}
                  disabled={!pasted.trim()}
                  style={{ ...secondaryButton, marginTop: "8px" }}
                >
                  붙여넣은 내용 읽기
                </button>
              </div>
            </>
          ) : null}

          {mode === "storeOnly" ? (
            <>
              <div
                style={{
                  border: "1px solid #bfdbfe",
                  backgroundColor: "#eff6ff",
                  borderRadius: "8px",
                  padding: "10px 12px",
                  fontSize: "13px",
                  color: "#1e40af",
                }}
              >
                {storeOnlyReason} 이 화면에서 받아적으실 필요는 없습니다 — 원본은 그대로 남으니
                필요할 때 열어보시면 됩니다.
              </div>

              {previewUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={previewUrl}
                  alt="올린 명세서 원본"
                  style={{
                    width: "100%",
                    maxHeight: "320px",
                    objectFit: "contain",
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    backgroundColor: "#f8fafc",
                  }}
                />
              ) : (
                <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                  올린 파일: {file?.name}
                </p>
              )}

              <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
                <div style={{ flex: "1 1 180px" }}>
                  <label style={labelStyle}>공급처 이름 *</label>
                  <input
                    value={supplierName}
                    onChange={(event) => setSupplierName(event.target.value)}
                    placeholder="예: 대성축산"
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: "0 1 150px" }}>
                  <label style={labelStyle}>서류 날짜</label>
                  <input
                    type="date"
                    value={issuedOn}
                    onChange={(event) => setIssuedOn(event.target.value)}
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: "0 1 150px" }}>
                  <label style={labelStyle}>명세서 번호</label>
                  <input
                    value={documentNo}
                    onChange={(event) => setDocumentNo(event.target.value)}
                    style={inputStyle}
                  />
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" onClick={handleSave} disabled={saving} style={primaryButton}>
                  {saving ? "보관 중…" : "원본 보관"}
                </button>
                <button type="button" onClick={reset} disabled={saving} style={secondaryButton}>
                  취소
                </button>
              </div>
            </>
          ) : null}

          {mode === "review" ? (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
                <div style={{ flex: "1 1 180px" }}>
                  <label style={labelStyle}>공급처 이름 *</label>
                  <input
                    value={supplierName}
                    onChange={(event) => setSupplierName(event.target.value)}
                    onBlur={() => void recallFormat()}
                    placeholder="예: 대성축산"
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: "0 1 150px" }}>
                  <label style={labelStyle}>서류 날짜</label>
                  <input
                    type="date"
                    value={issuedOn}
                    onChange={(event) => setIssuedOn(event.target.value)}
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: "0 1 150px" }}>
                  <label style={labelStyle}>명세서 번호</label>
                  <input
                    value={documentNo}
                    onChange={(event) => setDocumentNo(event.target.value)}
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: "0 1 150px" }}>
                  <label style={labelStyle}>서류 합계 금액</label>
                  <input
                    value={totalAmount}
                    onChange={(event) => setTotalAmount(event.target.value)}
                    inputMode="numeric"
                    placeholder="적혀 있으면"
                    style={inputStyle}
                  />
                </div>
              </div>

              {learned ? (
                <p style={{ margin: 0, fontSize: "12px", color: "#1e40af" }}>
                  전에 이 공급처 서류를 읽었던 방식을 그대로 적용했습니다.
                </p>
              ) : null}

              {previewUrl ? (
                <div>
                  <label style={labelStyle}>올린 원본 (보면서 입력하세요)</label>
                  {/* 사진 원본은 크기가 제각각이라 next/image의 사전 크기 지정이 맞지 않는다. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl}
                    alt="올린 명세서 원본"
                    style={{
                      width: "100%",
                      maxHeight: "360px",
                      objectFit: "contain",
                      border: "1px solid #e2e8f0",
                      borderRadius: "8px",
                      backgroundColor: "#f8fafc",
                    }}
                  />
                </div>
              ) : null}

              {file && !previewUrl ? (
                <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                  올린 파일: {file.name} — 원본은 그대로 보관됩니다.
                </p>
              ) : null}

              {grid && columnCount > 0 ? (
                <div>
                  <label style={labelStyle}>
                    각 칸이 무엇인지 — 틀렸으면 바꿔주세요 (한 번 고치면 이 공급처는 다음부터
                    기억합니다)
                  </label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {FIELD_ORDER.map((field) => (
                      <label key={field} style={{ fontSize: "12px", color: "#475569" }}>
                        {FIELD_LABELS[field]}{" "}
                        <select
                          value={columnMap[field] ?? ""}
                          onChange={(event) => changeColumn(field, event.target.value)}
                          style={{ ...inputStyle, width: "auto", padding: "5px 8px" }}
                        >
                          <option value="">없음</option>
                          {Array.from({ length: columnCount }, (_, index) => (
                            <option key={index} value={index}>
                              {index + 1}번째 칸
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#f8fafc" }}>
                      <th style={thStyle}>품목</th>
                      <th style={thStyle}>내 상품</th>
                      <th style={thStyle}>이력번호</th>
                      <th style={thStyle}>중량(kg)</th>
                      <th style={thStyle}>단가</th>
                      <th style={thStyle}>금액</th>
                      <th style={thStyle}>빠진 것</th>
                      <th style={thStyle} />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const gaps =
                        gapReport.lineGaps.find((item) => item.lineNo === line.lineNo)?.gaps ?? [];

                      return (
                        <tr key={line.lineNo} style={{ borderTop: "1px solid #e2e8f0" }}>
                          <td style={tdStyle}>
                            <input
                              value={line.itemName ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, { itemName: event.target.value || null })
                              }
                              style={cellInput}
                            />
                          </td>
                          <td style={tdStyle}>
                            <select
                              value={line.productId ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, { productId: event.target.value || null })
                              }
                              style={cellInput}
                            >
                              <option value="">선택</option>
                              {products.map((product) => (
                                <option key={product.id} value={product.id}>
                                  {product.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={tdStyle}>
                            <input
                              value={line.traceNo ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, { traceNo: event.target.value || null })
                              }
                              style={cellInput}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              value={line.labeledWeight ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, {
                                  labeledWeight: toNumber(event.target.value),
                                })
                              }
                              inputMode="decimal"
                              style={cellInput}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              value={line.unitPrice ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, { unitPrice: toNumber(event.target.value) })
                              }
                              inputMode="numeric"
                              style={cellInput}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              value={line.amount ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, { amount: toNumber(event.target.value) })
                              }
                              inputMode="numeric"
                              style={cellInput}
                            />
                          </td>
                          <td style={{ ...tdStyle, minWidth: "180px" }}>
                            {gaps.length === 0 ? (
                              <span style={{ fontSize: "12px", color: "#059669" }}>없음</span>
                            ) : (
                              <span
                                style={{ display: "flex", flexDirection: "column", gap: "3px" }}
                              >
                                {gaps.map((gap) => {
                                  const badge = SOURCE_BADGE[gap.source];

                                  return (
                                    <span
                                      key={gap.code}
                                      title={gap.why}
                                      style={{
                                        fontSize: "11px",
                                        color: badge.fg,
                                        backgroundColor: badge.bg,
                                        borderRadius: "5px",
                                        padding: "2px 6px",
                                      }}
                                    >
                                      {gap.label} · {badge.text}
                                    </span>
                                  );
                                })}
                              </span>
                            )}
                          </td>
                          <td style={tdStyle}>
                            <button
                              type="button"
                              onClick={() => removeLine(line.lineNo)}
                              style={{
                                border: "none",
                                background: "none",
                                color: "#94a3b8",
                                cursor: "pointer",
                                fontSize: "12px",
                              }}
                            >
                              삭제
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <button
                type="button"
                onClick={() => setLines((current) => [...current, emptyLine(current.length + 1)])}
                style={secondaryButton}
              >
                줄 추가
              </button>

              {gapReport.documentGaps.length > 0 ? (
                <div
                  style={{
                    border: "1px solid #fde68a",
                    backgroundColor: "#fffbeb",
                    borderRadius: "8px",
                    padding: "10px 12px",
                  }}
                >
                  {gapReport.documentGaps.map((gap) => (
                    <p
                      key={gap.code}
                      style={{ margin: "0 0 4px", fontSize: "12px", color: "#92400e" }}
                    >
                      {gap.label} — {gap.why}
                    </p>
                  ))}
                </div>
              ) : null}

              {supplierRequests.length > 0 ? (
                <div
                  style={{
                    border: "1px solid #fecaca",
                    backgroundColor: "#fef2f2",
                    borderRadius: "8px",
                    padding: "10px 12px",
                  }}
                >
                  <p style={{ margin: "0 0 6px", fontSize: "12px", fontWeight: 700, color: "#991b1b" }}>
                    공급처에 요청해야 채워지는 항목입니다 ({gapReport.incompleteLineCount}/
                    {gapReport.totalLineCount}줄)
                  </p>
                  {supplierRequests.map((text) => (
                    <p key={text} style={{ margin: "0 0 3px", fontSize: "12px", color: "#991b1b" }}>
                      · {text}
                    </p>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        `[${supplierName || "공급처"}] 명세서 확인 요청\n${supplierRequests
                          .map((text) => `- ${text}`)
                          .join("\n")}`,
                      )
                    }
                    style={{ ...secondaryButton, marginTop: "6px" }}
                  >
                    요청 문구 복사
                  </button>
                </div>
              ) : null}

              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" onClick={handleSave} disabled={saving} style={primaryButton}>
                  {saving ? "저장 중…" : "명세서 저장"}
                </button>
                <button type="button" onClick={reset} disabled={saving} style={secondaryButton}>
                  취소
                </button>
              </div>

              <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                빠진 항목이 있어도 저장할 수 있습니다. 나중에 공급처에서 받아 채우시면 됩니다.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "#475569",
  marginBottom: "5px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid #cbd5f5",
  borderRadius: "8px",
  padding: "8px 10px",
  fontSize: "13px",
  color: "#0f172a",
  backgroundColor: "#ffffff",
};

const cellInput: React.CSSProperties = {
  width: "100%",
  minWidth: "90px",
  border: "1px solid #e2e8f0",
  borderRadius: "6px",
  padding: "5px 7px",
  fontSize: "12px",
  color: "#0f172a",
  backgroundColor: "#ffffff",
};

const primaryButton: React.CSSProperties = {
  border: "none",
  borderRadius: "8px",
  backgroundColor: "#0f172a",
  color: "#ffffff",
  fontSize: "13px",
  fontWeight: 700,
  padding: "9px 16px",
  cursor: "pointer",
};

const secondaryButton: React.CSSProperties = {
  border: "1px solid #cbd5f5",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
  fontSize: "13px",
  fontWeight: 600,
  padding: "9px 14px",
  cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "12px",
  fontWeight: 700,
  color: "#475569",
  padding: "8px",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "6px 8px",
  verticalAlign: "top",
};
