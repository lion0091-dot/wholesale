"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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
  deleteInboundDocumentAction,
  discardInboundDocumentAction,
  extractDocumentTableAction,
  findUnfinishedDocumentPrelookupAction,
  getDocumentFileUrlAction,
  loadSupplierFormatAction,
  processDocumentPrelookupChunkAction,
  restoreInboundDocumentAction,
  retryDocumentPrelookupAction,
  saveInboundDocumentAction,
  type ActionResult,
  type DocumentLineInput,
  type DocumentPrelookupProgress,
} from "./document-actions";
import type { ScanProductOption } from "./inbound-scan-view";

/**
 * 공급처 명세서 올리기 (29단계 A).
 *
 * 서류가 들어오는 길이 여러 갈래다 — 이메일로 온 엑셀/CSV/PDF, 현장에서 받은
 * 종이를 찍은 사진. 읽히는 것(엑셀·CSV·붙여넣기·글자가 든 PDF)은 표로 보여주고,
 * 못 읽는 것(사진·스캔본 PDF)은 **원본만 보관한다.** 입고 화면에서 손으로
 * 받아적게 만들지 않는다 — 현장 화면은 바코드 찍는 데 집중해야 한다(잠긴 결정).
 *
 * 읽힌 경우의 마지막은 같다: 표를 사람이 확인하고, 플랫폼 기준에 견줘 뭐가
 * 빠졌는지 보고, 저장한다. 재고는 만들지 않는다.
 */

const FIELD_LABELS: Record<DocumentField, string> = {
  itemName: "품목",
  traceNo: "이력번호",
  lotNo: "묶음번호(이력번호 칸과 따로 있을 때만)",
  partName: "부위",
  grade: "등급",
  origin: "원산지",
  quantity: "수량",
  labeledWeight: "중량(kg)",
  unitPrice: "단가",
  amount: "금액",
};

const FIELD_ORDER: DocumentField[] = [
  "itemName",
  "traceNo",
  "lotNo",
  "partName",
  "grade",
  "origin",
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

export interface InboundDocumentRow {
  id: string;
  supplierName: string | null;
  documentNo: string | null;
  issuedOn: string | null;
  fileName: string | null;
  hasFile: boolean;
  status: string;
  totalAmount: number | null;
  createdAt: string;
  lineCount: number;
  /** 대조 화면(PENDING·CLOSED만) 진입용 — 줄 상태 요약. 그 외 상태(DRAFT·DISCARDED)는 null. */
  matchSummary: { completeLines: number; totalLines: number } | null;
}

interface EditableLine extends DocumentLine {
  productId: string | null;
}

function emptyLine(lineNo: number): EditableLine {
  return {
    lineNo,
    raw: "",
    itemName: null,
    traceNo: null,
    lotNo: null,
    traceTruncated: false,
    splitOf: null,
    partName: null,
    grade: null,
    origin: null,
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

export function InboundDocumentPanel({
  products,
  documents,
  canManageDocuments,
}: {
  products: ScanProductOption[];
  documents: InboundDocumentRow[];
  /** 완전 삭제(원본 포함)는 owner/manager만 — 매입 증빙 1년 보관 의무. */
  canManageDocuments: boolean;
}) {
  const router = useRouter();
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);

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
  // 이력/로트번호 사전조회 진행 상태 — 실물 도착 전에 미리 걸러 공급처에 등록을
  // 요청한다(사장님 지침 2026-09-24). 청크로 나눠 처리하므로(엑셀 대량 입고와
  // 같은 패턴, Hobby 실행시간 제한 회피) 완료까지 진행률을 보여준다.
  const [prelookupDocumentId, setPrelookupDocumentId] = useState<string | null>(null);
  const [prelookupProgress, setPrelookupProgress] = useState<DocumentPrelookupProgress | null>(null);
  const [prelookupRunning, setPrelookupRunning] = useState(false);
  const [unresolvedSupplierName, setUnresolvedSupplierName] = useState("");

  // 새로고침·재접속 시 끝나지 않은 사전조회가 있으면 이어받는다.
  useEffect(() => {
    void findUnfinishedDocumentPrelookupAction().then((result) => {
      if (result.success && result.data) {
        setPrelookupDocumentId(result.data.documentId);
        setPrelookupProgress(result.data);
        setOpen(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** finished가 될 때까지 청크를 반복 호출한다(엑셀 대량 입고의 drain과 같은 패턴). */
  const drainPrelookup = async (documentId: string) => {
    setPrelookupRunning(true);

    for (;;) {
      const result = await processDocumentPrelookupChunkAction(documentId);

      if (!result.success || !result.data) {
        setError(result.error ?? "이력 사전조회 중 오류가 발생했습니다.");
        break;
      }

      setPrelookupProgress(result.data);

      if (result.data.finished) {
        break;
      }
    }

    setPrelookupRunning(false);
    router.refresh();
  };

  const handleRetryPrelookup = async () => {
    if (!prelookupDocumentId) return;

    const result = await retryDocumentPrelookupAction(prelookupDocumentId);

    if (!result.success) {
      setError(result.error ?? "재시도 요청에 실패했습니다.");
      return;
    }

    await drainPrelookup(prelookupDocumentId);
  };

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
        lines.map((line) => ({
          lineNo: line.lineNo,
          productId: line.productId,
          productOrigin:
            products.find((product) => product.id === line.productId)?.origin ?? null,
        })),
      ),
    [supplierName, issuedOn, totalAmount, lines, products],
  );

  const supplierRequests = useMemo(
    () => buildSupplierRequestSummary(gapReport),
    [gapReport],
  );

  const runOnDocument = async (
    documentId: string,
    action: (id: string) => Promise<ActionResult>,
    successMessage: string,
  ) => {
    setBusyDocumentId(documentId);

    const result = await action(documentId);

    setBusyDocumentId(null);

    if (result.success) {
      setError(null);
      setNotice(successMessage);
      router.refresh();
    } else {
      setError(result.error ?? "처리하지 못했습니다.");
    }
  };

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
        : lines.filter((line) => line.itemName || line.traceNo || line.lotNo || line.labeledWeight !== null);

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
        lotNo: line.lotNo,
        partName: line.partName,
        grade: line.grade,
        origin: line.origin,
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
      const relinked = result.data?.relinkedScanCount ?? 0;

      setNotice(
        `명세서 ${result.data?.lineCount}줄을 저장했습니다.` +
          (relinked > 0 ? ` 먼저 찍혀 있던 박스 ${relinked}개를 이 명세서의 상품으로 확정했습니다.` : "")
      );
    }

    // 실물 도착 전에 미리 이력/로트번호를 조회해 없는 번호는 공급처에 등록을
    // 요청해야 한다(사장님 지침 2026-09-24). reset()이 supplierName을 지우니
    // 먼저 붙잡아둔다.
    setUnresolvedSupplierName(supplierName);

    const documentId = result.data?.documentId ?? null;
    const pendingPrelookupCount = result.data?.pendingPrelookupCount ?? 0;

    reset();

    if (documentId && pendingPrelookupCount > 0) {
      setPrelookupDocumentId(documentId);
      setPrelookupProgress(null);
      await drainPrelookup(documentId);
    } else {
      router.refresh();
    }
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

      {prelookupProgress ? (
        <div
          style={{
            margin: 0,
            padding: "10px 16px",
            fontSize: "13px",
            color: "#1e40af",
            backgroundColor: "#eff6ff",
            borderTop: "1px solid #bfdbfe",
          }}
        >
          <p style={{ margin: "0 0 6px", fontWeight: 700 }}>
            {prelookupProgress.finished
              ? "이력/로트번호 사전조회 완료"
              : prelookupRunning
                ? "이력/로트번호 사전조회 중… (창을 닫아도 이어서 처리됩니다)"
                : "사전조회가 끝나지 않았습니다"}
          </p>
          <p style={{ margin: "0 0 6px" }}>
            {prelookupProgress.done + prelookupProgress.failed} / {prelookupProgress.total}건
            {prelookupProgress.failed > 0 && ` · 확인 필요 ${prelookupProgress.failed}건`}
          </p>
          <div
            style={{
              height: "6px",
              borderRadius: "3px",
              backgroundColor: "#dbeafe",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.min(
                  100,
                  ((prelookupProgress.done + prelookupProgress.failed) /
                    Math.max(1, prelookupProgress.total)) *
                    100
                )}%`,
                height: "100%",
                backgroundColor: "#2563eb",
              }}
            />
          </div>

          {!prelookupProgress.finished && !prelookupRunning && prelookupDocumentId && (
            <button
              type="button"
              onClick={() => void drainPrelookup(prelookupDocumentId)}
              style={{ ...secondaryButton, marginTop: "10px" }}
            >
              이어서 처리
            </button>
          )}

          {prelookupProgress.finished && prelookupProgress.failedTraceNos.length > 0 && (
            <div style={{ marginTop: "10px", color: "#991b1b" }}>
              <p style={{ margin: "0 0 6px", fontWeight: 700 }}>
                다음 이력/로트번호가 정부 이력조회에서 확인되지 않았습니다 — 실물 도착 전에
                공급처에 등록을 요청하세요.
              </p>
              {prelookupProgress.failedTraceNos.map((traceNo) => (
                <p key={traceNo} style={{ margin: "0 0 3px", fontFamily: "monospace" }}>
                  · {traceNo}
                </p>
              ))}
              <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      `[${unresolvedSupplierName || "공급처"}] 이력번호 등록 확인 요청\n` +
                        `아래 이력/로트번호가 축산물이력제 조회에서 확인되지 않습니다. 등록 상태를 확인 부탁드립니다.\n` +
                        prelookupProgress.failedTraceNos.map((traceNo) => `- ${traceNo}`).join("\n"),
                    )
                  }
                  style={secondaryButton}
                >
                  요청 문구 복사
                </button>
                <button type="button" onClick={() => void handleRetryPrelookup()} style={secondaryButton}>
                  다시 조회
                </button>
              </div>
            </div>
          )}
        </div>
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

              <div>
                <label style={labelStyle}>올린 명세서</label>
                {documents.length === 0 ? (
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
                    아직 올린 명세서가 없습니다.
                  </p>
                ) : (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {documents.map((document) => (
                      <li
                        key={document.id}
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: "8px",
                          padding: "8px 0",
                          borderTop: "1px solid #e2e8f0",
                          fontSize: "13px",
                          opacity: document.status === "DISCARDED" ? 0.55 : 1,
                        }}
                      >
                        <span style={{ fontWeight: 600, color: "#0f172a" }}>
                          {document.supplierName ?? "공급처 미입력"}
                        </span>
                        {document.status === "DISCARDED" ? (
                          <span
                            style={{
                              fontSize: "11px",
                              borderRadius: "5px",
                              padding: "2px 6px",
                              color: "#475569",
                              backgroundColor: "#e2e8f0",
                            }}
                          >
                            취소됨
                          </span>
                        ) : null}
                        <span style={{ color: "#64748b" }}>
                          {document.issuedOn ?? document.createdAt.slice(0, 10)}
                        </span>
                        <span
                          style={{
                            fontSize: "11px",
                            borderRadius: "5px",
                            padding: "2px 6px",
                            color: document.lineCount > 0 ? "#065f46" : "#92400e",
                            backgroundColor: document.lineCount > 0 ? "#d1fae5" : "#fef3c7",
                          }}
                        >
                          {document.lineCount > 0
                            ? `품목 ${document.lineCount}줄`
                            : "원본만 보관 (내용 없음)"}
                        </span>
                        {document.matchSummary ? (
                          <span
                            style={{
                              fontSize: "11px",
                              borderRadius: "5px",
                              padding: "2px 6px",
                              color:
                                document.matchSummary.completeLines === document.matchSummary.totalLines
                                  ? "#065f46"
                                  : "#1e40af",
                              backgroundColor:
                                document.matchSummary.completeLines === document.matchSummary.totalLines
                                  ? "#d1fae5"
                                  : "#dbeafe",
                            }}
                          >
                            {document.matchSummary.completeLines}/{document.matchSummary.totalLines} 완료
                          </span>
                        ) : null}
                        {document.documentNo ? (
                          <span style={{ color: "#94a3b8", fontSize: "12px" }}>
                            {document.documentNo}
                          </span>
                        ) : null}

                        <span style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
                          {(document.status === "PENDING" || document.status === "CLOSED") && (
                            <Link href={`/dashboard/inbound/documents/${document.id}`} style={linkButton}>
                              대조
                            </Link>
                          )}
                          {document.hasFile ? (
                            <button
                              type="button"
                              disabled={busyDocumentId === document.id}
                              onClick={async () => {
                                setBusyDocumentId(document.id);

                                const result = await getDocumentFileUrlAction(document.id);

                                setBusyDocumentId(null);

                                if (result.success && result.data) {
                                  window.open(result.data, "_blank", "noopener");
                                } else {
                                  setError(result.error ?? "원본을 열지 못했습니다.");
                                }
                              }}
                              style={linkButton}
                            >
                              원본 보기
                            </button>
                          ) : (
                            <span style={{ fontSize: "12px", color: "#94a3b8" }}>원본 없음</span>
                          )}
                          {document.status === "DISCARDED" ? (
                            <>
                              <button
                                type="button"
                                disabled={busyDocumentId === document.id}
                                onClick={() =>
                                  void runOnDocument(
                                    document.id,
                                    restoreInboundDocumentAction,
                                    "명세서를 되살렸습니다.",
                                  )
                                }
                                style={linkButton}
                              >
                                되살리기
                              </button>
                              {canManageDocuments ? (
                                <button
                                  type="button"
                                  disabled={busyDocumentId === document.id}
                                  onClick={() => {
                                    if (
                                      !window.confirm(
                                        "원본까지 완전히 지웁니다. 되돌릴 수 없습니다.\n\n매입 명세서는 축산물이력법상 1년간 보관해야 합니다. 애초에 잘못 올린 서류만 지워주세요.",
                                      )
                                    ) {
                                      return;
                                    }

                                    void runOnDocument(
                                      document.id,
                                      deleteInboundDocumentAction,
                                      "명세서를 완전히 지웠습니다.",
                                    );
                                  }}
                                  style={{ ...linkButton, color: "#b91c1c" }}
                                >
                                  완전 삭제
                                </button>
                              ) : (
                                <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                                  완전 삭제는 관리자만
                                </span>
                              )}
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={busyDocumentId === document.id}
                              onClick={() =>
                                void runOnDocument(
                                  document.id,
                                  discardInboundDocumentAction,
                                  "목록에서 감췄습니다. 원본은 그대로 남아 있습니다.",
                                )
                              }
                              style={linkButton}
                            >
                              취소 처리
                            </button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
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
                      <th style={thStyle}>묶음번호</th>
                      <th style={thStyle}>부위</th>
                      <th style={thStyle}>등급</th>
                      <th style={thStyle}>원산지</th>
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
                              value={line.lotNo ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, { lotNo: event.target.value || null })
                              }
                              placeholder="두 칸 서식일 때만"
                              style={{ ...cellInput, minWidth: "120px" }}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              value={line.partName ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, { partName: event.target.value || null })
                              }
                              placeholder="등심 등"
                              style={{ ...cellInput, minWidth: "70px" }}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              value={line.grade ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, { grade: event.target.value || null })
                              }
                              placeholder="1++"
                              style={{ ...cellInput, minWidth: "60px" }}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              value={line.origin ?? ""}
                              onChange={(event) =>
                                updateLine(line.lineNo, { origin: event.target.value || null })
                              }
                              placeholder="국내산"
                              style={{ ...cellInput, minWidth: "70px" }}
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

const linkButton: React.CSSProperties = {
  border: "none",
  background: "none",
  color: "#1d4ed8",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
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
