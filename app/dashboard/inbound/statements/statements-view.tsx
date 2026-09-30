"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  getStatementFileUrlAction,
  hideStatementFileAction,
  recordStatementFileAction,
} from "./actions";

export interface StatementFileItem {
  id: string;
  statementDate: string | null;
  memo: string | null;
  fileName: string;
  sizeBytes: number | null;
  createdAt: string;
  supplierName: string | null;
}

export interface SupplierOption {
  id: string;
  name: string;
}

interface StatementsViewProps {
  wholesalerId: string | null;
  files: StatementFileItem[];
  suppliers: SupplierOption[];
  canManage: boolean;
}

// 버킷(inbound-documents) 한도와 같다(마이그레이션 164).
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const panelStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  backgroundColor: "#fff",
  padding: "14px",
};
const labelStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 700,
  color: "#475569",
  display: "block",
  marginBottom: "4px",
};
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
const smallButton: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  backgroundColor: "#fff",
  color: "#334155",
  fontSize: "12px",
  fontWeight: 600,
  padding: "5px 10px",
  cursor: "pointer",
};

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Storage 키에는 한글을 못 쓰므로 확장자(영숫자)만 남긴다. 원래 파일명은 DB에 따로 저장된다. */
function safeExtension(fileName: string): string {
  const match = fileName.match(/\.([A-Za-z0-9]{1,8})$/);

  return match ? `.${match[1].toLowerCase()}` : "";
}

export function StatementsView({ wholesalerId, files, suppliers, canManage }: StatementsViewProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(false);

    const formData = new FormData(event.currentTarget);
    const file = formData.get("file");

    if (!wholesalerId) {
      setError("공급사 정보를 찾을 수 없습니다.");
      return;
    }

    if (!(file instanceof File) || file.size === 0) {
      setError("올릴 파일을 선택해주세요.");
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setError("파일 용량은 20MB 이하만 올릴 수 있습니다.");
      return;
    }

    const supplierId = String(formData.get("supplier_id") ?? "");
    const statementDate = String(formData.get("statement_date") ?? "");
    const memo = String(formData.get("memo") ?? "");

    startTransition(async () => {
      const path = `${wholesalerId}/${crypto.randomUUID()}${safeExtension(file.name)}`;
      const supabase = createClient();

      const { error: uploadError } = await supabase.storage
        .from("inbound-documents")
        .upload(path, file, { contentType: file.type || undefined, upsert: false });

      if (uploadError) {
        setError("파일을 올리지 못했습니다. 잠시 후 다시 시도해주세요.");
        return;
      }

      const result = await recordStatementFileAction({
        storagePath: path,
        fileName: file.name,
        mimeType: file.type || null,
        sizeBytes: file.size,
        supplierId: supplierId || null,
        statementDate: statementDate || null,
        memo: memo || null,
      });

      if (!result.success) {
        setError(result.error ?? "명세서 정보를 저장하지 못했습니다.");
        return;
      }

      setSaved(true);
      formRef.current?.reset();
      router.refresh();
    });
  };

  const handleOpen = async (id: string) => {
    setError(null);
    setBusyId(id);

    const result = await getStatementFileUrlAction(id);

    setBusyId(null);

    if (!result.success || !result.url) {
      setError(result.error ?? "파일을 열지 못했습니다.");
      return;
    }

    window.location.assign(result.url);
  };

  const handleHide = async (item: StatementFileItem) => {
    if (
      !window.confirm(
        `"${item.fileName}"을(를) 목록에서 숨길까요?\n\n파일은 삭제되지 않고 보관됩니다. 숨긴 뒤에는 이 화면에서 다시 볼 수 없습니다.`
      )
    ) {
      return;
    }

    setError(null);
    setBusyId(item.id);

    const result = await hideStatementFileAction(item.id);

    setBusyId(null);

    if (!result.success) {
      setError(result.error ?? "숨기지 못했습니다.");
      return;
    }

    router.refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div
        style={{
          backgroundColor: "#fffbeb",
          border: "1px solid #fde68a",
          color: "#92400e",
          fontSize: "12px",
          lineHeight: 1.7,
          padding: "12px 14px",
          borderRadius: "8px",
        }}
      >
        <strong>종이 원본은 폐기하지 마세요.</strong> 이 보관함은 찾아보기 편하도록 사본을 두는 용도이며,
        법에서 정한 기록 보관 방식을 대신한다고 보장하지 않습니다. 올린 파일은 삭제할 수 없고 목록에서
        숨기기만 할 수 있습니다.
      </div>

      <form ref={formRef} onSubmit={handleSubmit} noValidate style={panelStyle}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="statement_file" style={labelStyle}>
              파일 (엑셀·PDF·사진 등 모두 가능, 최대 20MB)
            </label>
            <input id="statement_file" name="file" type="file" disabled={pending} style={inputStyle} />
          </div>

          <div>
            <label htmlFor="statement_supplier" style={labelStyle}>
              공급처 (선택)
            </label>
            <select id="statement_supplier" name="supplier_id" disabled={pending} style={inputStyle} defaultValue="">
              <option value="">선택 안 함</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="statement_date" style={labelStyle}>
              거래일 (선택)
            </label>
            <input id="statement_date" name="statement_date" type="date" disabled={pending} style={inputStyle} />
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="statement_memo" style={labelStyle}>
              메모 (선택 — 파일에 여러 날짜가 섞였으면 여기에 적어두세요)
            </label>
            <input
              id="statement_memo"
              name="memo"
              type="text"
              maxLength={500}
              disabled={pending}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button type="submit" disabled={pending} style={{ ...primaryButton, opacity: pending ? 0.6 : 1 }}>
            {pending ? "올리는 중..." : "올려서 보관"}
          </button>
          {saved && !error && <span style={{ fontSize: "12px", color: "#166534" }}>✓ 보관되었습니다.</span>}
        </div>
      </form>

      {error && (
        <p role="alert" style={{ fontSize: "13px", color: "#b91c1c", margin: 0, lineHeight: 1.6 }}>
          {error}
        </p>
      )}

      <div style={panelStyle}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
          보관 중인 명세서 ({files.length}건{files.length >= 200 ? " · 최근 200건만 표시" : ""})
        </div>

        {files.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>아직 보관한 명세서가 없습니다.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {files.map((item) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  padding: "10px 0",
                  borderTop: "1px solid #f1f5f9",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", wordBreak: "break-all" }}>
                    {item.fileName}
                    <span style={{ fontWeight: 500, color: "#94a3b8", marginLeft: "6px" }}>
                      {formatSize(item.sizeBytes)}
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px", lineHeight: 1.6 }}>
                    {item.supplierName ?? "공급처 미지정"}
                    {item.statementDate ? ` · 거래일 ${item.statementDate}` : ""} · 올린 시각{" "}
                    {formatDateTime(item.createdAt)}
                    {item.memo ? ` · ${item.memo}` : ""}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => handleOpen(item.id)}
                    style={smallButton}
                  >
                    내려받기
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      disabled={busyId === item.id}
                      onClick={() => handleHide(item)}
                      style={smallButton}
                    >
                      숨기기
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
