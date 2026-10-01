"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { splitScanAction } from "../actions";

export interface SplitBox {
  id: string;
  traceNo: string;
  remainingWeight: number;
  unit: string;
  createdAt: string;
  productName: string;
}

export interface SplitProduct {
  id: string;
  name: string;
  unit: string;
}

interface Line {
  key: number;
  productId: string;
  weight: string;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function SplitView({ boxes, products }: { boxes: SplitBox[]; products: SplitProduct[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([{ key: 1, productId: "", weight: "" }]);
  const [nextKey, setNextKey] = useState(2);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const selected = boxes.find((box) => box.id === selectedId) ?? null;
  const candidates = useMemo(
    () => (selected ? products.filter((product) => product.unit === selected.unit) : []),
    [products, selected],
  );

  const shownBoxes = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (q === "") return boxes;

    return boxes.filter((box) => box.traceNo.toLowerCase().includes(q) || box.productName.toLowerCase().includes(q));
  }, [boxes, query]);

  const total = lines.reduce((sum, line) => sum + (Number(line.weight) > 0 ? Number(line.weight) : 0), 0);
  const loss = selected ? round3(selected.remainingWeight - total) : 0;
  const complete = lines.length > 0 && lines.every((line) => line.productId && Number(line.weight) > 0);
  const canSubmit = selected !== null && complete && loss >= 0 && !pending;

  function pick(box: SplitBox) {
    setSelectedId(box.id);
    setLines([{ key: 1, productId: "", weight: "" }]);
    setNextKey(2);
    setMessage(null);
  }

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function submit() {
    if (!selected || !canSubmit) return;

    startTransition(async () => {
      const result = await splitScanAction(
        selected.id,
        lines.map((line) => ({ productId: line.productId, weight: Number(line.weight) })),
      );

      if (!result.success) {
        setMessage({ tone: "error", text: result.error ?? "쪼개기에 실패했습니다." });

        return;
      }

      setMessage({
        tone: "ok",
        text: `쪼개기를 마쳤습니다. 박스 ${result.data?.childIds.length ?? lines.length}개가 생겼고 손실은 ${result.data?.loss ?? loss}${selected.unit}입니다.`,
      });
      setSelectedId(null);
      setLines([{ key: 1, productId: "", weight: "" }]);
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          style={{ margin: 0, padding: "10px 12px", borderRadius: "8px", fontSize: "14px", background: message.tone === "ok" ? "#dcfce7" : "#fee2e2", color: message.tone === "ok" ? "#166534" : "#991b1b" }}
        >
          {message.text}
        </p>
      ) : null}

      <section style={{ border: "1px solid #e2e8f0", borderRadius: "10px", background: "#fff", padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 800 }}>1. 쪼갤 박스 고르기</h2>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="이력번호나 상품 이름으로 찾기"
          aria-label="쪼갤 박스 검색"
          style={{ padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "14px" }}
        />
        {shownBoxes.length === 0 ? (
          <p style={{ margin: 0, color: "#64748b", fontSize: "14px" }}>
            {boxes.length === 0 ? "쪼갤 수 있는 박스가 없습니다." : "찾는 박스가 없습니다."}
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, maxHeight: "260px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" }}>
            {shownBoxes.map((box) => (
              <li key={box.id} style={{ listStyle: "none" }}>
                <button
                  type="button"
                  onClick={() => pick(box)}
                  aria-pressed={box.id === selectedId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "8px",
                    width: "100%",
                    padding: "10px 12px",
                    textAlign: "left",
                    fontSize: "14px",
                    cursor: "pointer",
                    border: box.id === selectedId ? "2px solid #2563eb" : "1px solid #e2e8f0",
                    borderRadius: "8px",
                    background: box.id === selectedId ? "#eff6ff" : "#fff",
                  }}
                >
                  <span>
                    <strong>{box.productName}</strong>
                    <span style={{ display: "block", fontSize: "12px", color: "#64748b" }}>{box.traceNo}</span>
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {box.remainingWeight}
                    {box.unit}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected ? (
        <section style={{ border: "1px solid #e2e8f0", borderRadius: "10px", background: "#fff", padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 800 }}>2. 나눈 부위와 실중량</h2>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
            {selected.productName} · 남은 {selected.remainingWeight}
            {selected.unit}. 나눈 부위마다 한 줄씩, 저울에 잰 중량을 입력하세요.
          </p>

          {lines.map((line, index) => (
            <div key={line.key} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <select
                value={line.productId}
                onChange={(event) => updateLine(line.key, { productId: event.target.value })}
                aria-label={`${index + 1}번째 줄 부위`}
                style={{ flex: 1, padding: "10px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "14px" }}
              >
                <option value="">부위(상품) 선택</option>
                {candidates.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.001"
                value={line.weight}
                onChange={(event) => updateLine(line.key, { weight: event.target.value })}
                placeholder={`중량(${selected.unit})`}
                aria-label={`${index + 1}번째 줄 중량`}
                style={{ width: "120px", padding: "10px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "14px" }}
              />
              <button
                type="button"
                onClick={() => setLines((current) => (current.length > 1 ? current.filter((l) => l.key !== line.key) : current))}
                disabled={lines.length === 1}
                aria-label={`${index + 1}번째 줄 삭제`}
                style={{ padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: "8px", background: "#fff", cursor: lines.length === 1 ? "default" : "pointer" }}
              >
                ✕
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => {
              setLines((current) => [...current, { key: nextKey, productId: "", weight: "" }]);
              setNextKey(nextKey + 1);
            }}
            disabled={lines.length >= 30}
            style={{ alignSelf: "flex-start", padding: "8px 12px", border: "1px dashed #94a3b8", borderRadius: "8px", background: "#fff", cursor: "pointer", fontSize: "14px" }}
          >
            + 부위 줄 추가
          </button>

          <p style={{ margin: 0, fontSize: "14px", color: loss < 0 ? "#991b1b" : "#0f172a" }}>
            나눈 합계 <strong>{round3(total)}{selected.unit}</strong> · 손실 <strong>{loss}{selected.unit}</strong>
            {loss < 0 ? " — 나눈 합계가 남은 중량보다 큽니다." : ""}
          </p>

          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            style={{ padding: "12px", border: "none", borderRadius: "8px", background: canSubmit ? "#2563eb" : "#cbd5e1", color: "#fff", fontSize: "15px", fontWeight: 700, cursor: canSubmit ? "pointer" : "default" }}
          >
            {pending ? "처리 중…" : "작업 끝"}
          </button>
        </section>
      ) : null}
    </div>
  );
}
