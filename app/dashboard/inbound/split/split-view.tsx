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

interface Line {
  key: number;
  part: string;
  weight: string;
  /** 이 부위의 kg당 가격(선택). 지육 원가를 부위에 나누는 기준이다. 비우면 상품 관리의 판매 기본가를 쓴다. */
  price: string;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function SplitView({ boxes, parts, initialQuery }: { boxes: SplitBox[]; parts: string[]; initialQuery: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(initialQuery);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([{ key: 1, part: "", weight: "", price: "" }]);
  const [nextKey, setNextKey] = useState(2);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const selected = boxes.find((box) => box.id === selectedId) ?? null;

  const shownBoxes = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (q === "") return boxes;

    return boxes.filter((box) => box.traceNo.toLowerCase().includes(q) || box.productName.toLowerCase().includes(q));
  }, [boxes, query]);

  const total = lines.reduce((sum, line) => sum + (Number(line.weight) > 0 ? Number(line.weight) : 0), 0);
  const loss = selected ? round3(selected.remainingWeight - total) : 0;
  const complete = lines.length > 0 && lines.every((line) => line.part && Number(line.weight) > 0);
  const canSubmit = selected !== null && complete && loss >= 0 && !pending;

  function pick(box: SplitBox) {
    setSelectedId(box.id);
    setLines([{ key: 1, part: "", weight: "", price: "" }]);
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
        lines.map((line) => ({
          part: line.part,
          weight: Number(line.weight),
          ...(Number(line.price) > 0 ? { unitPrice: Number(line.price) } : {}),
        })),
      );

      if (!result.success) {
        setMessage({ tone: "error", text: result.error ?? "쪼개기에 실패했습니다." });

        return;
      }

      const created = result.data?.createdProducts ?? [];
      const fallbackParts = Array.from(
        new Set((result.data?.priceFallback ?? []).map((lineNo) => lines[lineNo - 1]?.part).filter((part): part is string => Boolean(part))),
      );

      setMessage({
        tone: "ok",
        text:
          `쪼개기를 마쳤습니다. 박스 ${result.data?.childIds.length ?? lines.length}개가 생겼고 손실은 ${result.data?.loss ?? loss}${selected.unit}입니다.` +
          (created.length > 0
            ? ` 새 상품 ${created.length}개가 만들어졌습니다(${created.join(", ")}) — 상품 관리에서 가격을 넣고 판매를 켜 주세요.`
            : "") +
          (fallbackParts.length > 0
            ? ` 가격이 없던 부위(${fallbackParts.join(", ")})는 지육 단가 기준으로 원가를 나눴습니다. 사무실에 부위 판매 기본가를 확인해 상품 관리에 넣어 주세요.`
            : ""),
      });
      setSelectedId(null);
      setLines([{ key: 1, part: "", weight: "", price: "" }]);
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            // 최근 입고 박스 밖의 오래된 박스도 찾도록 서버에 다시 묻는다.
            router.push(query.trim() ? `/dashboard/inbound/split?q=${encodeURIComponent(query.trim())}` : "/dashboard/inbound/split");
          }}
          style={{ display: "flex", gap: "8px" }}
        >
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="이력번호나 상품 이름으로 찾기"
            aria-label="쪼갤 박스 검색"
            style={{ flex: 1, padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "14px" }}
          />
          <button type="submit" style={{ padding: "10px 14px", border: "1px solid #cbd5e1", borderRadius: "8px", background: "#fff", cursor: "pointer", fontSize: "14px" }}>
            찾기
          </button>
        </form>
        <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
          최근 입고한 박스 300개까지 보여줍니다. 오래된 박스는 이력번호나 상품 이름을 넣고 &quot;찾기&quot;를 누르세요.
        </p>
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
            {selected.unit}. 나눈 부위마다 한 줄씩, 저울에 잰 중량을 입력하세요. 가격 칸은 지육 원가를 부위에 나누는 기준입니다. 상품 관리에 부위 판매 기본가가 있으면 비워 두세요. 없는 부위는 사무실에 물어서 적으면 되고, 못 적어도 쪼개기는 됩니다. 품종·등급·원산지 같은 나머지는 이 박스 정보로 자동으로 채워집니다.
          </p>

          {lines.map((line, index) => (
            <div key={line.key} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <select
                value={line.part}
                onChange={(event) => updateLine(line.key, { part: event.target.value })}
                aria-label={`${index + 1}번째 줄 부위`}
                style={{ flex: 1, padding: "10px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "14px" }}
              >
                <option value="">부위 선택</option>
                {parts.map((part) => (
                  <option key={part} value={part}>
                    {part}
                  </option>
                ))}
              </select>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={line.price}
                onChange={(event) => updateLine(line.key, { price: event.target.value })}
                placeholder={`${selected.unit}당 가격(선택)`}
                aria-label={`${index + 1}번째 줄 부위 가격`}
                style={{ width: "130px", padding: "10px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "14px" }}
              />
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
              setLines((current) => [...current, { key: nextKey, part: "", weight: "", price: "" }]);
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
