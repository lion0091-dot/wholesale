"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatWon } from "@/lib/orders/status";
import {
  assembleBundleAction,
  deleteBundleAction,
  disassembleAssemblyAction,
  saveBundleAction,
  traceBundleUsageAction,
  type AssembledSet,
  type TraceUsageRow,
} from "./actions";

export interface ComponentOption {
  id: string;
  name: string;
  category: string;
  unit: string;
  stockQuantity: number;
}

export interface BundleComponent {
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  /** 지금 박스에 남아 있는 양 (기한 지난 박스 제외) */
  available: number;
}

export interface BundleRow {
  bundleId: string;
  bundleCode: string;
  productId: string;
  productName: string;
  basePrice: number;
  isActive: boolean;
  stockQuantity: number;
  memo: string | null;
  buildable: number;
  onHandSets: number;
  components: BundleComponent[];
}

export interface AssemblyTrace {
  traceNo: string;
  productName: string;
  weight: number;
  grade: string | null;
  slaughterDate: string | null;
}

export interface AssemblyRow {
  assemblyId: string;
  bundleId: string;
  bundleCode: string;
  setNo: string;
  productName: string;
  totalWeight: number;
  bestBefore: string | null;
  status: string;
  remaining: number;
  assembledBy: string | null;
  createdAt: string;
  sourceTraces: AssemblyTrace[];
}

interface Props {
  bundles: BundleRow[];
  assemblies: AssemblyRow[];
  components: ComponentOption[];
}

interface DraftItem {
  productId: string;
  quantity: string;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BundleManagerView({ bundles, assemblies, components }: Props) {
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 구성 편집 — null이면 닫힌 상태, "new"면 새 세트, 그 외는 bundleId
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [bundleCode, setBundleCode] = useState("");
  const [memo, setMemo] = useState("");
  const [items, setItems] = useState<DraftItem[]>([{ productId: "", quantity: "" }]);

  const [setCounts, setSetCounts] = useState<Record<string, string>>({});
  const [lastAssembled, setLastAssembled] = useState<AssembledSet[]>([]);
  const [openSources, setOpenSources] = useState<Record<string, boolean>>({});

  const [traceQuery, setTraceQuery] = useState("");
  const [traceRows, setTraceRows] = useState<TraceUsageRow[] | null>(null);

  const openNew = () => {
    setEditing("new");
    setName("");
    setBasePrice("");
    setBundleCode("");
    setMemo("");
    setItems([{ productId: "", quantity: "" }]);
    setError(null);
  };

  const openEdit = (bundle: BundleRow) => {
    setEditing(bundle.bundleId);
    setName(bundle.productName);
    setBasePrice(String(bundle.basePrice));
    setBundleCode(bundle.bundleCode);
    setMemo(bundle.memo ?? "");
    setItems(
      bundle.components.map((component) => ({
        productId: component.productId,
        quantity: String(component.quantity),
      }))
    );
    setError(null);
  };

  const saveBundle = async () => {
    const parsed = items
      .filter((item) => item.productId)
      .map((item) => ({ productId: item.productId, quantity: Number.parseFloat(item.quantity) }));

    if (parsed.length === 0) {
      setError("구성품을 하나 이상 고르세요.");
      return;
    }

    if (parsed.some((item) => !Number.isFinite(item.quantity) || item.quantity <= 0)) {
      setError("구성품 소요량을 0보다 큰 숫자로 입력해주세요.");
      return;
    }

    setBusy(true);

    const result = await saveBundleAction({
      items: parsed,
      bundleId: editing === "new" ? null : editing,
      name: name.trim() || null,
      basePrice: basePrice.trim() ? Number.parseFloat(basePrice) : null,
      bundleCode: bundleCode.trim() || null,
      memo: memo.trim() || null,
    });

    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "저장에 실패했습니다.");
      return;
    }

    setEditing(null);
    setNotice(
      result.data?.created
        ? `세트 상품을 만들었습니다 (${result.data.bundleCode}). 판매가를 확인하고 상품 관리에서 '판매중'으로 바꾸면 고객에게 보입니다.`
        : "세트 구성을 저장했습니다."
    );
    router.refresh();
  };

  const assemble = async (bundle: BundleRow) => {
    const count = Number.parseInt(setCounts[bundle.bundleId] ?? "1", 10);

    if (!Number.isFinite(count) || count < 1) {
      setError("제작 수량을 1 이상으로 입력해주세요.");
      return;
    }

    setBusy(true);
    setError(null);

    const result = await assembleBundleAction(bundle.bundleId, count);

    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "세트 제작에 실패했습니다.");
      return;
    }

    const sets = result.data?.sets ?? [];

    setLastAssembled(sets);
    setNotice(
      `${sets.length}세트를 만들었습니다 (${sets.map((set) => set.setNo).join(", ")}). ` +
        "박스에 붙일 라벨을 인쇄하세요."
    );
    router.refresh();
  };

  const disassemble = async (assembly: AssemblyRow) => {
    if (
      !window.confirm(
        `${assembly.setNo} 세트를 해체하시겠습니까?\n구성품이 원래 박스로 되돌아갑니다.`
      )
    ) {
      return;
    }

    setBusy(true);
    const result = await disassembleAssemblyAction(assembly.assemblyId);
    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "해체에 실패했습니다.");
      return;
    }

    setNotice(`${assembly.setNo} 세트를 해체했습니다.`);
    router.refresh();
  };

  const searchTrace = async () => {
    const result = await traceBundleUsageAction(traceQuery);

    if (!result.success) {
      setError(result.error ?? "조회에 실패했습니다.");
      return;
    }

    setTraceRows(result.data ?? []);
  };

  const componentName = (productId: string) =>
    components.find((component) => component.id === productId)?.name ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {error && <div style={{ ...messageStyle, backgroundColor: "#fee2e2", color: "#991b1b" }}>{error}</div>}
      {notice && <div style={{ ...messageStyle, backgroundColor: "#eff6ff", color: "#1e40af" }}>{notice}</div>}

      {lastAssembled.length > 0 && (
        <section style={{ ...panelStyle, borderColor: "#c7d2fe", backgroundColor: "#eef2ff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ fontSize: "13px", color: "#3730a3" }}>
              방금 만든 세트{" "}
              <strong style={{ fontFamily: "monospace" }}>
                {lastAssembled.map((set) => set.setNo).join(", ")}
              </strong>
            </div>
            <Link
              href={`/dashboard/bundles/labels?ids=${lastAssembled.map((set) => set.assemblyId).join(",")}`}
              target="_blank"
              style={{ ...buttonStyle, backgroundColor: "#0f172a", color: "#fff", textDecoration: "none" }}
            >
              🖨 세트 라벨 인쇄
            </Link>
          </div>
        </section>
      )}

      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>세트 목록</div>
          <button type="button" onClick={openNew} style={{ ...buttonStyle, backgroundColor: "#0f172a", color: "#fff" }}>
            + 새 세트 만들기
          </button>
        </div>

        {bundles.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>
            아직 세트가 없습니다. 자주 함께 나가는 부위를 묶어 세트로 만들어 보세요.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {bundles.map((bundle) => (
              <div key={bundle.bundleId} style={rowStyle}>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 260px" }}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ ...chipStyle, backgroundColor: "#ede9fe", color: "#5b21b6" }}>
                      {bundle.bundleCode}
                    </span>
                    <span style={{ fontWeight: 700 }}>{bundle.productName}</span>
                    <span style={{ fontSize: "12px", color: "#475569" }}>{formatWon(bundle.basePrice)}</span>
                    {!bundle.isActive && (
                      <span style={{ ...chipStyle, backgroundColor: "#fef3c7", color: "#92400e" }}>판매중지</span>
                    )}
                  </div>

                  <div style={{ fontSize: "12px", color: "#64748b" }}>
                    {bundle.components
                      .map((component) => `${component.productName} ${component.quantity}${component.unit}`)
                      .join(" + ")}
                  </div>

                  <div style={{ fontSize: "12px", color: "#475569" }}>
                    지금 만들 수 있는 양 <strong>{bundle.buildable}세트</strong> · 보유{" "}
                    <strong>{bundle.onHandSets}세트</strong>
                    {bundle.components.some((component) => component.available < component.quantity) && (
                      <span style={{ color: "#991b1b" }}>
                        {" "}
                        · 부족:{" "}
                        {bundle.components
                          .filter((component) => component.available < component.quantity)
                          .map((component) => `${component.productName} ${component.available}${component.unit}`)
                          .join(", ")}
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={setCounts[bundle.bundleId] ?? "1"}
                    onChange={(event) =>
                      setSetCounts((prev) => ({ ...prev, [bundle.bundleId]: event.target.value }))
                    }
                    aria-label="제작 수량"
                    style={{ ...inputStyle, width: "70px" }}
                  />
                  <button
                    type="button"
                    disabled={busy || bundle.buildable < 1}
                    onClick={() => void assemble(bundle)}
                    style={{
                      ...buttonStyle,
                      backgroundColor: bundle.buildable < 1 ? "#f1f5f9" : "#166534",
                      color: bundle.buildable < 1 ? "#94a3b8" : "#fff",
                    }}
                  >
                    세트 제작
                  </button>
                  <button type="button" onClick={() => openEdit(bundle)} style={buttonStyle}>
                    구성 수정
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!window.confirm(`${bundle.bundleCode} 세트 구성을 지우시겠습니까?`)) return;

                      const result = await deleteBundleAction(bundle.bundleId);

                      if (!result.success) {
                        setError(result.error ?? "삭제에 실패했습니다.");
                        return;
                      }

                      router.refresh();
                    }}
                    style={{ ...buttonStyle, borderColor: "#fca5a5", color: "#b91c1c" }}
                  >
                    구성 삭제
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <section style={{ ...panelStyle, borderColor: "#0f172a" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
            {editing === "new" ? "새 세트 만들기" : "세트 구성 수정"}
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
            <div style={{ flex: "1 1 200px" }}>
              <label htmlFor="bundle_name" style={labelStyle}>
                세트 상품명
              </label>
              <input
                id="bundle_name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="삼겹살+목살 실속세트"
                style={inputStyle}
                disabled={editing !== "new"}
              />
            </div>

            <div style={{ width: "130px" }}>
              <label htmlFor="bundle_price" style={labelStyle}>
                판매가 (세트당)
              </label>
              <input
                id="bundle_price"
                type="number"
                min="0"
                step="100"
                value={basePrice}
                onChange={(event) => setBasePrice(event.target.value)}
                placeholder="45000"
                style={inputStyle}
                disabled={editing !== "new"}
              />
            </div>

            <div style={{ width: "120px" }}>
              <label htmlFor="bundle_code" style={labelStyle}>
                자체 상품코드
              </label>
              <input
                id="bundle_code"
                value={bundleCode}
                onChange={(event) => setBundleCode(event.target.value)}
                placeholder="자동(BND-0001)"
                style={inputStyle}
              />
            </div>

            <div style={{ flex: "1 1 160px" }}>
              <label htmlFor="bundle_memo" style={labelStyle}>
                메모
              </label>
              <input
                id="bundle_memo"
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
                placeholder="3~4인 가정용"
                style={inputStyle}
              />
            </div>
          </div>

          {editing !== "new" && (
            <p style={{ fontSize: "11px", color: "#94a3b8", margin: "0 0 10px" }}>
              상품명·판매가는 상품 관리에서 바꿉니다. 여기서는 구성과 코드만 고칩니다.
            </p>
          )}

          <div style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "6px" }}>
            세트 1개에 들어가는 구성품
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {items.map((item, index) => (
              <div key={index} style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={item.productId}
                  onChange={(event) =>
                    setItems((prev) =>
                      prev.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, productId: event.target.value } : row
                      )
                    )
                  }
                  aria-label="구성품"
                  style={{ ...inputStyle, flex: "1 1 200px" }}
                >
                  <option value="">상품 선택…</option>
                  {components.map((component) => (
                    <option key={component.id} value={component.id}>
                      {component.name} (재고 {component.stockQuantity}
                      {component.unit})
                    </option>
                  ))}
                </select>

                <input
                  type="number"
                  min="0"
                  step="0.001"
                  value={item.quantity}
                  onChange={(event) =>
                    setItems((prev) =>
                      prev.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, quantity: event.target.value } : row
                      )
                    )
                  }
                  placeholder="2.000"
                  aria-label={`${componentName(item.productId)} 소요량`}
                  style={{ ...inputStyle, width: "100px" }}
                />

                <button
                  type="button"
                  onClick={() => setItems((prev) => prev.filter((_, rowIndex) => rowIndex !== index))}
                  style={{ ...buttonStyle, borderColor: "#fca5a5", color: "#b91c1c" }}
                >
                  빼기
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: "6px", marginTop: "10px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setItems((prev) => [...prev, { productId: "", quantity: "" }])}
              style={buttonStyle}
            >
              + 구성품 추가
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveBundle()}
              style={{ ...buttonStyle, backgroundColor: "#0f172a", color: "#fff" }}
            >
              저장
            </button>
            <button type="button" onClick={() => setEditing(null)} style={buttonStyle}>
              닫기
            </button>
          </div>
        </section>
      )}

      <section style={panelStyle}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
          제작 내역{" "}
          <span style={{ color: "#94a3b8", fontWeight: 400 }}>
            최근 50건 · 세트번호를 누르면 들어간 이력번호가 펼쳐집니다
          </span>
        </div>

        {assemblies.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>아직 제작한 세트가 없습니다.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {assemblies.map((assembly) => {
              const open = Boolean(openSources[assembly.assemblyId]);
              const shipped = assembly.status === "NORMAL" && assembly.remaining <= 0;

              return (
                <div key={assembly.assemblyId} style={{ ...rowStyle, flexDirection: "column", alignItems: "stretch" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "11px", color: "#94a3b8" }}>{formatDateTime(assembly.createdAt)}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setOpenSources((prev) => ({ ...prev, [assembly.assemblyId]: !open }))
                        }
                        style={{
                          fontFamily: "monospace",
                          fontSize: "13px",
                          fontWeight: 700,
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "#1e40af",
                          cursor: "pointer",
                        }}
                      >
                        {assembly.setNo} {open ? "▾" : "▸"}
                      </button>
                      <span style={{ fontWeight: 600 }}>{assembly.productName}</span>
                      <span style={{ fontSize: "12px", color: "#475569" }}>{assembly.totalWeight}kg</span>
                      {assembly.bestBefore && (
                        <span style={{ fontSize: "12px", color: "#64748b" }}>기한 {assembly.bestBefore}</span>
                      )}
                      {assembly.status === "VOIDED" ? (
                        <span style={{ ...chipStyle, backgroundColor: "#f1f5f9", color: "#64748b" }}>해체됨</span>
                      ) : shipped ? (
                        <span style={{ ...chipStyle, backgroundColor: "#dbeafe", color: "#1e40af" }}>출고됨</span>
                      ) : (
                        <span style={{ ...chipStyle, backgroundColor: "#dcfce7", color: "#166534" }}>재고</span>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <Link
                        href={`/dashboard/bundles/labels?ids=${assembly.assemblyId}`}
                        target="_blank"
                        style={{ ...buttonStyle, textDecoration: "none", color: "#334155" }}
                      >
                        라벨
                      </Link>
                      {assembly.status === "NORMAL" && !shipped && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void disassemble(assembly)}
                          style={{ ...buttonStyle, borderColor: "#fca5a5", color: "#b91c1c" }}
                        >
                          해체
                        </button>
                      )}
                    </div>
                  </div>

                  {open && (
                    <div
                      style={{
                        marginTop: "8px",
                        borderTop: "1px solid #e2e8f0",
                        paddingTop: "8px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                      }}
                    >
                      {assembly.sourceTraces.map((trace) => (
                        <div
                          key={`${assembly.assemblyId}-${trace.traceNo}`}
                          style={{ display: "flex", gap: "8px", fontSize: "12px", color: "#475569", flexWrap: "wrap" }}
                        >
                          <span style={{ fontFamily: "monospace", color: "#0f172a" }}>{trace.traceNo}</span>
                          <span>{trace.productName}</span>
                          <span>{trace.weight}kg</span>
                          {trace.grade && <span>{trace.grade}</span>}
                          {trace.slaughterDate && <span>도축 {trace.slaughterDate}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section style={panelStyle}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "4px" }}>
          이력번호 역추적
        </div>
        <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 10px" }}>
          이 번호의 고기가 어느 세트에 들어가 누구에게 나갔는지 한 번에 확인합니다. 이력 추적 요청이
          들어왔을 때 그대로 답할 수 있는 화면입니다.
        </p>

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <input
            value={traceQuery}
            onChange={(event) => setTraceQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void searchTrace();
            }}
            placeholder="002123456789 (일부만 입력해도 됩니다)"
            aria-label="이력번호"
            style={{ ...inputStyle, flex: "1 1 240px" }}
          />
          <button type="button" onClick={() => void searchTrace()} style={buttonStyle}>
            조회
          </button>
        </div>

        {traceRows !== null && (
          <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
            {traceRows.length === 0 ? (
              <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>
                이 번호로 만든 세트가 없습니다. (세트로 묶지 않고 그대로 나간 건은 입출고 내역에서
                이력번호로 검색하세요)
              </p>
            ) : (
              traceRows.map((row, index) => (
                <div
                  key={`${row.setNo}-${index}`}
                  style={{ ...rowStyle, fontSize: "12px", justifyContent: "flex-start", gap: "8px" }}
                >
                  <span style={{ fontFamily: "monospace", color: "#0f172a" }}>{row.traceNo}</span>
                  <span>→</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{row.setNo}</span>
                  <span>{row.setProductName}</span>
                  <span style={{ color: "#64748b" }}>
                    {row.componentName} {row.usedWeight}kg
                  </span>
                  {row.assemblyStatus === "VOIDED" ? (
                    <span style={{ ...chipStyle, backgroundColor: "#f1f5f9", color: "#64748b" }}>해체됨</span>
                  ) : row.orderNumber ? (
                    <span style={{ color: "#1e40af" }}>
                      {row.orderNumber} · {row.retailerName}
                      {row.shippedAt ? ` (${formatDateTime(row.shippedAt)})` : ""}
                    </span>
                  ) : (
                    <span style={{ color: "#166534" }}>창고 보관중</span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </div>
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "13px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  backgroundColor: "#fff",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "13px",
  fontWeight: 600,
  borderRadius: "6px",
  border: "1px solid #e2e8f0",
  backgroundColor: "#f8fafc",
  color: "#334155",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const chipStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 700,
  borderRadius: "4px",
  padding: "3px 7px",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "10px",
  flexWrap: "wrap",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "10px 12px",
  fontSize: "13px",
  color: "#0f172a",
};

const messageStyle: React.CSSProperties = {
  borderRadius: "8px",
  padding: "10px 12px",
  fontSize: "13px",
};
