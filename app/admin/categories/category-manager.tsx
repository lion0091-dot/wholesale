"use client";

import { useState, useTransition } from "react";
import { addProductCategoryAction, deleteProductCategoryAction } from "./actions";

interface Category {
  id: string;
  name: string;
}

export function CategoryManager({ initialCategories }: { initialCategories: Category[] }) {
  const [categories, setCategories] = useState(initialCategories);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleAdd = () => {
    setError(null);
    startTransition(async () => {
      const result = await addProductCategoryAction(name);

      if (!result.success) {
        setError(result.error ?? "추가에 실패했습니다.");
        return;
      }

      setName("");
      window.location.reload();
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm("삭제하면 이 카테고리를 쓰던 상품은 값이 그대로 남지만 목록에서 사라집니다. 삭제할까요?")) {
      return;
    }

    startTransition(async () => {
      const result = await deleteProductCategoryAction(id);

      if (result.success) {
        setCategories((prev) => prev.filter((c) => c.id !== id));
      } else {
        setError(result.error ?? "삭제에 실패했습니다.");
      }
    });
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="새 카테고리명"
          style={{ flex: 1, padding: "8px 10px", fontSize: "13px", border: "1px solid #cbd5e1", borderRadius: "6px" }}
        />
        <button
          type="button"
          disabled={pending || !name.trim()}
          onClick={handleAdd}
          style={{
            fontSize: "13px",
            fontWeight: 700,
            color: "#ffffff",
            backgroundColor: "#0f172a",
            border: "none",
            borderRadius: "6px",
            padding: "8px 16px",
            cursor: pending ? "wait" : "pointer",
          }}
        >
          추가
        </button>
      </div>

      {error && <p style={{ fontSize: "12px", color: "#b91c1c", marginBottom: "12px" }}>{error}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {categories.map((category) => (
          <div
            key={category.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 12px",
              border: "1px solid #e2e8f0",
              borderRadius: "6px",
            }}
          >
            <span style={{ fontSize: "13px" }}>{category.name}</span>
            <button
              type="button"
              disabled={pending}
              onClick={() => handleDelete(category.id)}
              style={{
                fontSize: "11px",
                color: "#b91c1c",
                backgroundColor: "#ffffff",
                border: "1px solid #fca5a5",
                borderRadius: "6px",
                padding: "4px 10px",
                cursor: pending ? "not-allowed" : "pointer",
              }}
            >
              삭제
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
