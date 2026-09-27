"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PurchaseOrderLineInput } from "@/lib/purchase-orders/lines";
import { PURCHASE_ORDER_MAX_LINES } from "@/lib/purchase-orders/lines";
import { buildPurchaseOrderMessage } from "@/lib/purchase-orders/message";
import {
  createPurchaseOrderAction,
  createSupplierAction,
  parsePurchaseOrderFileAction,
  setPurchaseOrderStatusAction,
  setSupplierActiveAction,
  updateSupplierAction,
} from "./actions";

export interface SupplierRow {
  id: string;
  name: string;
  phone: string | null;
  note: string | null;
  aliases: string[];
  is_active: boolean;
}

export interface PurchaseOrderRow {
  id: string;
  supplier_id: string;
  supplier_name: string;
  ordered_on: string;
  expected_on: string | null;
  note: string | null;
  status: "OPEN" | "CLOSED" | "CANCELLED";
  purchase_order_lines: Array<{
    line_no: number;
    category: string;
    subcategory: string | null;
    grade: string | null;
    origin: string;
    quantity: number;
    unit: string;
    unit_price: number | null;
  }>;
}

interface Props {
  canManage: boolean;
  categories: string[];
  subcategoriesByCategory: Record<string, string[]>;
  suppliers: SupplierRow[];
  orders: PurchaseOrderRow[];
}

const STATUS_LABEL: Record<PurchaseOrderRow["status"], { text: string; bg: string; color: string }> = {
  OPEN: { text: "진행 중", bg: "#dbeafe", color: "#1d4ed8" },
  CLOSED: { text: "마감", bg: "#dcfce7", color: "#166534" },
  CANCELLED: { text: "취소", bg: "#f1f5f9", color: "#64748b" },
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  fontSize: "13px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  boxSizing: "border-box",
  backgroundColor: "#fff",
};

const labelStyle: React.CSSProperties = { display: "block", fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "4px" };
const buttonStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: "13px",
  fontWeight: 700,
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  backgroundColor: "#fff",
  color: "#334155",
  cursor: "pointer",
};
const primaryButtonStyle: React.CSSProperties = { ...buttonStyle, border: "none", backgroundColor: "#2563eb", color: "#fff" };

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");

  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

const today = () => new Date().toISOString().slice(0, 10);
const emptyLine = (category = ""): PurchaseOrderLineInput => ({
  category,
  subcategory: "",
  grade: "",
  origin: "국내산",
  quantity: "",
  unitPrice: "",
});

function specText(line: PurchaseOrderRow["purchase_order_lines"][number]): string {
  return [line.category, line.subcategory, line.grade, line.origin].filter(Boolean).join(" ");
}

export function PurchaseOrderView({ canManage, categories, subcategoriesByCategory, suppliers, orders }: Props) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const activeSuppliers = suppliers.filter((supplier) => supplier.is_active);
  const supplierNameById = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
  const [orderedOn, setOrderedOn] = useState(today);
  const [expectedOn, setExpectedOn] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<PurchaseOrderLineInput[]>([emptyLine()]);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [includePrice, setIncludePrice] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const updateLine = (index: number, patch: Partial<PurchaseOrderLineInput>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
    setRowErrors((prev) => {
      if (!(index in prev)) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    const formData = new FormData();
    formData.set("file", file);

    const result = await parsePurchaseOrderFileAction(formData);

    setBusy(false);

    if (fileInput.current) fileInput.current.value = "";

    if (!result.success || !result.data) {
      setError(result.error ?? "엑셀을 읽지 못했습니다.");
      return;
    }

    const uploaded = result.data.rows;
    const keepExisting = lines.filter((line) => Object.values(line).some((value) => value.trim() !== "" && value !== "국내산"));

    setLines([...keepExisting, ...uploaded.map((row) => row.input)]);
    setRowErrors(
      Object.fromEntries(
        uploaded.flatMap((row, offset) => (row.error ? [[keepExisting.length + offset, `엑셀 ${row.rowNo}행: ${row.error}`]] : []))
      )
    );

    const badCount = uploaded.filter((row) => row.error).length;

    setNotice(
      badCount > 0
        ? `${uploaded.length}줄을 읽었습니다. 빨간 표시가 있는 ${badCount}줄을 고친 뒤 저장하세요.`
        : `${uploaded.length}줄을 읽었습니다. 내용을 확인하고 저장하세요.`
    );
  };

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);

    const filled = lines.filter((line) => Object.values(line).some((value) => value.trim() !== "" && value !== "국내산"));

    const result = await createPurchaseOrderAction({
      supplierId,
      orderedOn,
      expectedOn,
      note,
      lines: filled,
    });

    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "저장에 실패했습니다.");
      return;
    }

    setSupplierId("");
    setExpectedOn("");
    setNote("");
    setLines([emptyLine()]);
    setRowErrors({});
    setOpen(false);
    setNotice("발주서를 저장했습니다.");
    router.refresh();
  };

  // 카톡 본문에 붙여 넣을 문구 — 공급처에 보내는 것은 사장님이 카톡에서 직접 붙여 넣는다.
  const handleCopy = async (order: PurchaseOrderRow) => {
    try {
      await copyText(
        buildPurchaseOrderMessage(
          {
            supplierName: supplierNameById.get(order.supplier_id) ?? order.supplier_name,
            orderedOn: order.ordered_on,
            expectedOn: order.expected_on,
            note: order.note,
            lines: order.purchase_order_lines.map((line) => ({
              category: line.category,
              subcategory: line.subcategory,
              grade: line.grade,
              origin: line.origin,
              quantity: Number(line.quantity),
              unit: line.unit,
              unitPrice: line.unit_price === null ? null : Number(line.unit_price),
            })),
          },
          { includePrice }
        )
      );
      setCopiedId(order.id);
      window.setTimeout(() => setCopiedId((current) => (current === order.id ? null : current)), 2500);
    } catch {
      setError("복사하지 못했습니다. 브라우저의 복사 권한을 확인해주세요.");
    }
  };

  const handleStatus = async (order: PurchaseOrderRow, action: "close" | "cancel" | "reopen") => {
    if (action === "cancel" && !window.confirm(`${order.supplier_name} 발주서를 취소하시겠습니까?`)) return;

    setBusy(true);
    setError(null);

    const result = await setPurchaseOrderStatusAction(order.id, action);

    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "처리에 실패했습니다.");
      return;
    }

    router.refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {error && (
        <div role="alert" style={{ border: "1px solid #fecaca", backgroundColor: "#fef2f2", color: "#991b1b", borderRadius: "8px", padding: "10px 12px", fontSize: "13px" }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ border: "1px solid #bbf7d0", backgroundColor: "#f0fdf4", color: "#166534", borderRadius: "8px", padding: "10px 12px", fontSize: "13px" }}>
          {notice}
        </div>
      )}

      {canManage ? (
        <section style={{ border: "1px solid #e2e8f0", borderRadius: "12px", padding: "14px", backgroundColor: "#fff" }}>
          {!open ? (
            <button type="button" style={primaryButtonStyle} onClick={() => setOpen(true)}>
              + 새 발주서 작성
            </button>
          ) : (
            <div style={{ display: "grid", gap: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
                <div>
                  <label htmlFor="po-supplier" style={labelStyle}>공급처 *</label>
                  <select id="po-supplier" value={supplierId} onChange={(event) => setSupplierId(event.target.value)} style={fieldStyle}>
                    <option value="">{activeSuppliers.length === 0 ? "아래 거래처 관리에서 먼저 등록하세요" : "거래처를 고르세요"}</option>
                    {activeSuppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                    ))}
                  </select>
                  <QuickSupplierAdd onCreated={(id) => { setSupplierId(id); router.refresh(); }} setError={setError} />
                </div>
                <div>
                  <label htmlFor="po-ordered" style={labelStyle}>발주일 *</label>
                  <input id="po-ordered" type="date" value={orderedOn} onChange={(event) => setOrderedOn(event.target.value)} style={fieldStyle} />
                </div>
                <div>
                  <label htmlFor="po-expected" style={labelStyle}>도착 예정일 (선택)</label>
                  <input id="po-expected" type="date" value={expectedOn} min={orderedOn} onChange={(event) => setExpectedOn(event.target.value)} style={fieldStyle} />
                </div>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
                <a href="/dashboard/purchase-orders/template" style={{ ...buttonStyle, textDecoration: "none" }}>
                  엑셀 양식 내려받기
                </a>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => fileInput.current?.click()}>
                  엑셀 올리기
                </button>
                <input ref={fileInput} type="file" accept=".xlsx" hidden onChange={(event) => void handleFile(event.target.files?.[0])} />
                <span style={{ fontSize: "12px", color: "#64748b" }}>양식을 채워 올리면 아래 표에 채워지고, 확인한 뒤 저장합니다.</span>
              </div>

              <div style={{ display: "grid", gap: "8px" }}>
                {lines.map((line, index) => {
                  const parts = subcategoriesByCategory[line.category] ?? [];

                  return (
                    <div key={index} style={{ border: `1px solid ${rowErrors[index] ? "#fca5a5" : "#e2e8f0"}`, borderRadius: "8px", padding: "8px", backgroundColor: rowErrors[index] ? "#fef2f2" : "#f8fafc" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "6px" }}>
                        <select aria-label={`${index + 1}번째 줄 축종`} value={line.category} onChange={(event) => updateLine(index, { category: event.target.value })} style={fieldStyle}>
                          <option value="">축종 선택</option>
                          {categories.map((name) => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                          {line.category && !categories.includes(line.category) && <option value={line.category}>{line.category} (없는 축종)</option>}
                        </select>
                        <input aria-label={`${index + 1}번째 줄 부위`} list={`po-parts-${index}`} value={line.subcategory} onChange={(event) => updateLine(index, { subcategory: event.target.value })} placeholder="부위 (예: 등심)" style={fieldStyle} autoComplete="off" />
                        <datalist id={`po-parts-${index}`}>
                          {parts.map((name) => (
                            <option key={name} value={name} />
                          ))}
                        </datalist>
                        <input aria-label={`${index + 1}번째 줄 등급`} value={line.grade} onChange={(event) => updateLine(index, { grade: event.target.value })} placeholder="등급 (예: 1++)" style={fieldStyle} autoComplete="off" />
                        <input aria-label={`${index + 1}번째 줄 원산지`} value={line.origin} onChange={(event) => updateLine(index, { origin: event.target.value })} placeholder="원산지" style={fieldStyle} autoComplete="off" />
                        <input aria-label={`${index + 1}번째 줄 수량`} inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} placeholder="수량(kg)" style={fieldStyle} autoComplete="off" />
                        <input aria-label={`${index + 1}번째 줄 단가`} inputMode="numeric" value={line.unitPrice} onChange={(event) => updateLine(index, { unitPrice: event.target.value })} placeholder="단가(원/kg, 선택)" style={fieldStyle} autoComplete="off" />
                      </div>
                      {rowErrors[index] && <p style={{ margin: "6px 0 0", fontSize: "12px", color: "#b91c1c" }}>{rowErrors[index]}</p>}
                      {lines.length > 1 && (
                        <button type="button" onClick={() => { setLines((prev) => prev.filter((_, i) => i !== index)); setRowErrors({}); }} style={{ marginTop: "6px", border: "none", background: "none", padding: 0, fontSize: "12px", color: "#64748b", cursor: "pointer" }}>
                          이 줄 지우기
                        </button>
                      )}
                    </div>
                  );
                })}
                {lines.length < PURCHASE_ORDER_MAX_LINES && (
                  <button type="button" style={{ ...buttonStyle, justifySelf: "start" }} onClick={() => setLines((prev) => [...prev, emptyLine(prev[prev.length - 1]?.category ?? "")])}>
                    + 줄 추가
                  </button>
                )}
              </div>

              <div>
                <label htmlFor="po-note" style={labelStyle}>메모 (선택)</label>
                <textarea id="po-note" value={note} maxLength={500} rows={2} onChange={(event) => setNote(event.target.value)} style={{ ...fieldStyle, resize: "vertical" }} />
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" style={primaryButtonStyle} disabled={busy} onClick={() => void handleSave()}>
                  {busy ? "처리 중..." : "발주서 저장"}
                </button>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => { setOpen(false); setError(null); }}>
                  닫기
                </button>
              </div>
            </div>
          )}
        </section>
      ) : (
        <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>발주서 작성과 수정은 사장님·매니저만 할 수 있습니다. 직원은 조회만 됩니다.</p>
      )}

      <SupplierPanel suppliers={suppliers} canManage={canManage} setError={setError} />

      <section style={{ display: "grid", gap: "10px" }}>
        {orders.length > 0 && (
          <label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "12px", color: "#475569" }}>
            <input type="checkbox" checked={includePrice} onChange={(event) => setIncludePrice(event.target.checked)} />
            카톡 문구에 단가도 넣기
          </label>
        )}
        {orders.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>아직 작성한 발주서가 없습니다.</p>
        ) : (
          orders.map((order) => {
            const badge = STATUS_LABEL[order.status];
            const total = order.purchase_order_lines.reduce((sum, line) => sum + Number(line.quantity), 0);

            return (
              <article key={order.id} style={{ border: "1px solid #e2e8f0", borderRadius: "12px", padding: "12px 14px", backgroundColor: "#fff" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
                  <strong style={{ fontSize: "15px", color: "#0f172a" }}>{supplierNameById.get(order.supplier_id) ?? order.supplier_name}</strong>
                  <span style={{ fontSize: "11px", fontWeight: 700, backgroundColor: badge.bg, color: badge.color, borderRadius: "4px", padding: "2px 6px" }}>{badge.text}</span>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>
                    발주 {order.ordered_on}
                    {order.expected_on ? ` · 도착 예정 ${order.expected_on}` : ""} · 합계 {total.toLocaleString("ko-KR")}kg
                  </span>
                </div>
                <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: "3px", fontSize: "13px", color: "#334155" }}>
                  {order.purchase_order_lines.map((line) => (
                    <li key={line.line_no}>
                      {specText(line)} — <strong>{Number(line.quantity).toLocaleString("ko-KR")}{line.unit}</strong>
                      {line.unit_price !== null ? ` · ${Number(line.unit_price).toLocaleString("ko-KR")}원/${line.unit}` : ""}
                    </li>
                  ))}
                </ul>
                {order.note && <p style={{ margin: "6px 0 0", fontSize: "12px", color: "#64748b" }}>메모: {order.note}</p>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
                  <button type="button" style={buttonStyle} onClick={() => void handleCopy(order)}>
                    {copiedId === order.id ? "복사했습니다 — 카톡에 붙여넣기" : "카톡용 문구 복사"}
                  </button>
                  {canManage &&
                    (order.status === "OPEN" ? (
                      <>
                        <button type="button" style={buttonStyle} disabled={busy} onClick={() => void handleStatus(order, "close")}>마감(다 받음)</button>
                        <button type="button" style={buttonStyle} disabled={busy} onClick={() => void handleStatus(order, "cancel")}>취소</button>
                      </>
                    ) : (
                      <button type="button" style={buttonStyle} disabled={busy} onClick={() => void handleStatus(order, "reopen")}>다시 열기</button>
                    ))}
                </div>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}


/** 발주서 작성 중 목록에 없는 거래처를 그 자리에서 이름만으로 빨리 추가한다 — 자세한 정보는 아래 거래처 관리에서 채운다. */
function QuickSupplierAdd({ onCreated, setError }: { onCreated: (id: string) => void; setError: (message: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ marginTop: "4px", border: "none", background: "none", padding: 0, fontSize: "12px", color: "#2563eb", cursor: "pointer" }}>
        + 목록에 없는 거래처 추가
      </button>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);

    const result = await createSupplierAction({ name, phone: "", note: "", aliases: "" });

    setBusy(false);

    if (!result.success || !result.data) {
      setError(result.error ?? "거래처 추가에 실패했습니다.");
      return;
    }

    setName("");
    setOpen(false);
    onCreated(result.data.id);
  };

  return (
    <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
      <input value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} placeholder="새 거래처 이름" style={fieldStyle} aria-label="새 거래처 이름" />
      <button type="button" style={primaryButtonStyle} disabled={busy} onClick={() => void save()}>추가</button>
      <button type="button" style={buttonStyle} onClick={() => { setOpen(false); setName(""); }}>취소</button>
    </div>
  );
}

const emptySupplierForm = { name: "", phone: "", note: "", aliases: "" };

/** 거래처 관리 — 공급처 목록을 만들고 고친다. 발주서·입고는 이 목록에서 고르기만 한다. */
function SupplierPanel({ suppliers, canManage, setError }: { suppliers: SupplierRow[]; canManage: boolean; setError: (message: string | null) => void }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState(emptySupplierForm);
  const [busy, setBusy] = useState(false);

  const startEdit = (supplier: SupplierRow | null) => {
    setError(null);
    setEditingId(supplier ? supplier.id : "new");
    setForm(supplier ? { name: supplier.name, phone: supplier.phone ?? "", note: supplier.note ?? "", aliases: supplier.aliases.join(", ") } : emptySupplierForm);
  };

  const save = async () => {
    setBusy(true);
    setError(null);

    const result = editingId === "new" ? await createSupplierAction(form) : await updateSupplierAction(editingId as string, form);

    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "저장에 실패했습니다.");
      return;
    }

    setEditingId(null);
    router.refresh();
  };

  const toggleActive = async (supplier: SupplierRow) => {
    setBusy(true);
    setError(null);

    const result = await setSupplierActiveAction(supplier.id, !supplier.is_active);

    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "처리에 실패했습니다.");
      return;
    }

    router.refresh();
  };

  return (
    <details style={{ border: "1px solid #e2e8f0", borderRadius: "12px", padding: "12px 14px", backgroundColor: "#fff" }} open={suppliers.length === 0}>
      <summary style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a", cursor: "pointer" }}>
        거래처 관리 <span style={{ fontWeight: 400, color: "#64748b", fontSize: "12px" }}>물건을 사 오는 공급처 {suppliers.length}곳</span>
      </summary>

      <div style={{ display: "grid", gap: "8px", marginTop: "10px" }}>
        {suppliers.length === 0 && <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>등록된 거래처가 없습니다. 아래 버튼으로 처음 거래처를 등록하세요.</p>}

        {suppliers.map((supplier) =>
          editingId === supplier.id ? (
            <SupplierForm key={supplier.id} form={form} setForm={setForm} busy={busy} onSave={() => void save()} onCancel={() => setEditingId(null)} />
          ) : (
            <div key={supplier.id} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", opacity: supplier.is_active ? 1 : 0.6 }}>
              <strong style={{ fontSize: "14px", color: "#0f172a" }}>{supplier.name}</strong>
              {!supplier.is_active && <span style={{ fontSize: "11px", backgroundColor: "#f1f5f9", color: "#64748b", borderRadius: "4px", padding: "2px 6px" }}>사용 중지</span>}
              <span style={{ fontSize: "12px", color: "#64748b" }}>
                {[supplier.phone, supplier.aliases.length > 0 ? `명세서 표기: ${supplier.aliases.join(", ")}` : null, supplier.note].filter(Boolean).join(" · ")}
              </span>
              {canManage && (
                <span style={{ display: "flex", gap: "6px", marginLeft: "auto" }}>
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => startEdit(supplier)}>수정</button>
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => void toggleActive(supplier)}>{supplier.is_active ? "사용 중지" : "다시 사용"}</button>
                </span>
              )}
            </div>
          )
        )}

        {canManage &&
          (editingId === "new" ? (
            <SupplierForm form={form} setForm={setForm} busy={busy} onSave={() => void save()} onCancel={() => setEditingId(null)} />
          ) : (
            <button type="button" style={{ ...buttonStyle, justifySelf: "start" }} disabled={busy} onClick={() => startEdit(null)}>
              + 거래처 등록
            </button>
          ))}
        {!canManage && <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>거래처 등록·수정은 사장님·매니저만 할 수 있습니다.</p>}
      </div>
    </details>
  );
}

function SupplierForm({
  form,
  setForm,
  busy,
  onSave,
  onCancel,
}: {
  form: typeof emptySupplierForm;
  setForm: (next: typeof emptySupplierForm) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ border: "1px solid #cbd5e1", borderRadius: "8px", padding: "10px", display: "grid", gap: "8px", backgroundColor: "#f8fafc" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px" }}>
        <input aria-label="거래처 이름" value={form.name} maxLength={80} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="거래처 이름 *" style={fieldStyle} autoComplete="off" />
        <input aria-label="연락처" value={form.phone} maxLength={30} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="연락처 (선택)" style={fieldStyle} autoComplete="off" />
      </div>
      <input aria-label="명세서에 다르게 적히는 이름" value={form.aliases} onChange={(event) => setForm({ ...form, aliases: event.target.value })} placeholder="명세서에 다르게 적히는 이름 (쉼표로 구분, 선택)" style={fieldStyle} autoComplete="off" />
      <input aria-label="메모" value={form.note} maxLength={500} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="메모 (선택)" style={fieldStyle} autoComplete="off" />
      <div style={{ display: "flex", gap: "6px" }}>
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={onSave}>{busy ? "저장 중..." : "저장"}</button>
        <button type="button" style={buttonStyle} disabled={busy} onClick={onCancel}>취소</button>
      </div>
    </div>
  );
}
